import { render } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { indexedDbApiKeyStore, lastFour } from '../shared/api-key-store.ts';
import { grantDataConsent, revokeDataConsent, watchDataConsent } from '../shared/data-consent.ts';
import type { StaleReason } from '../shared/series-notes.ts';
import type { BackupFile } from '../background/backup.ts';
import type {
  ImportResponse,
  LineRef,
  Message,
  ModelStatus,
  ModelStatusResponse,
  AutoTranslateResponse,
  PagesResponse,
  PageView,
  SeriesResponse,
  StatusResponse,
  TestConnectionResponse,
} from '../shared/messages.ts';
import { DEFAULT_PAGE_MODE, savePageMode, watchPageMode, type PageMode } from '../shared/page-mode.ts';
import { Badge, Button, Callout, PageHeader, Progress, SegmentedControl, Switch, type SegmentOption } from './components.tsx';
import { SeriesNotesSection } from './series-notes.tsx';
import { DEFAULT_LEVEL, DisplaySwitch, Transcript, type Display, type Level } from './transcript.tsx';
import { sidePanelView, type OverallStatus, type PageEntry } from './view.ts';

/**
 * 點圖示啟動時，SW 用 sidepanel.html?tabId=N 打開這個 tab 專屬的 side panel。
 * 從 Chrome 內建 side panel 選單打開的沒有 tabId，也沒有 activeTab，只能提示去點圖示。
 */
function readTabId(): number | undefined {
  const raw = new URLSearchParams(location.search).get('tabId');
  return raw === null ? undefined : Number(raw);
}

const send = <R,>(message: Message) => chrome.runtime.sendMessage<Message, R>(message);

const mb = (bytes: number) => (bytes / 2 ** 20).toFixed(1);

function ModelStatusLine({ status, onRetry }: { status: ModelStatus; onRetry: () => void }) {
  switch (status.state) {
    case 'downloading':
      return (
        <p role="status">
          第一次使用，下載辨識模型中：{mb(status.loaded)} / {mb(status.total)} MB
          <progress value={status.loaded} max={status.total} />
        </p>
      );
    case 'loading':
      return <p role="status">載入辨識模型中…</p>;
    case 'error':
      return (
        <Callout tone="danger" role="alert">
          <p>辨識模型無法使用：{status.message}</p>
          <Button onClick={onRetry}>重試</Button>
        </Callout>
      );
    default:
      return null;
  }
}

/** 逐字稿的共用狀態：依 Page Mode 的顯示方式（#76）與 hover 同步（#39）。 */
interface TranscriptSync {
  display: Display;
  /** 頁面上滑鼠所在的那句。 */
  hovered: LineRef | undefined;
  /** 滑過 panel 的某行 → 頁面上那句高亮；null＝離開。 */
  onLineHover: (line: LineRef | null) => void;
}

const STALE_TEXT: Record<StaleReason, string> = {
  notes: 'Series Notes 已更新，這頁是用舊筆記翻的',
  version: '翻譯模型或 prompt 已更新，這頁是用舊版翻的',
};

/** 過時只提示、不自動重翻（spec #27 第 4.3 節）；按「重新翻譯」只重翻這一頁。 */
function StaleHint({ reason, onRetranslate }: { reason: StaleReason; onRetranslate: () => void }) {
  return (
    <Callout tone="warn" role="group" aria-label="過時提示">
      <span>{STALE_TEXT[reason]}</span>
      <Button onClick={onRetranslate}>重新翻譯</Button>
    </Callout>
  );
}

function PageItem({
  entry: { page, side, heading, translationStatus },
  onRetry,
  onRetranslate,
  sync,
}: {
  entry: PageEntry;
  onRetry: () => void;
  onRetranslate: () => void;
  sync: TranscriptSync;
}) {
  const { transcript } = page;
  const { display, hovered, onLineHover } = sync;
  const headingId = useId();
  return (
    <li aria-labelledby={headingId}>
      <PageHeader
        id={headingId}
        side={side}
        heading={heading}
        status={
          translationStatus && (
            <p class="translation-status" role="status" aria-label="翻譯狀態">
              {translationStatus}
            </p>
          )
        }
      />
      {transcript.state === 'analyzing' && <Progress>辨識中…</Progress>}
      {transcript.state === 'pending' && <Callout>未翻譯（自動翻譯已關閉，按「翻譯此頁」）</Callout>}
      {transcript.state === 'error' && <Callout tone="danger">辨識失敗：{transcript.message}</Callout>}
      {transcript.state === 'done' && transcript.stale && !transcript.translating && (
        <StaleHint reason={transcript.stale} onRetranslate={onRetranslate} />
      )}
      {transcript.state === 'done' && transcript.translating && <Progress>翻譯中…</Progress>}
      {transcript.state === 'done' && transcript.translateError && (
        <Callout tone="danger" role="alert">
          <p>翻譯失敗，改顯示 kuromoji 讀音：{transcript.translateError}</p>
          <Button onClick={onRetry}>重試</Button>
        </Callout>
      )}
      {transcript.state === 'done' && (
        <Transcript
          text={transcript.text}
          translated={transcript.translated}
          display={display}
          hoveredId={hovered?.pageHash === page.pageHash ? hovered.lineId : undefined}
          onHover={(lineId) => onLineHover(lineId === null ? null : { pageHash: page.pageHash, lineId })}
        />
      )}
    </li>
  );
}

const apiKeys = indexedDbApiKeyStore();

/**
 * 匯出／匯入 JSON（#38）：全部 Series、網址模式、Series Notes、翻譯快取，給兩台電腦之間搬資料；不含 API key。
 * 匯入是合併、本機優先。
 */
function Backup() {
  const [result, setResult] = useState<string | undefined>(undefined);

  async function exportFile() {
    const data = await send<BackupFile>({ type: 'panel:export' });
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `naruhodo-${new Date(data.exportedAt).toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importFile(file: File) {
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      setResult('匯入失敗：不是 JSON 檔');
      return;
    }
    const r = await send<ImportResponse>({ type: 'panel:import', data });
    setResult(r.ok ? '匯入完成' : `匯入失敗：${r.error}`);
  }

  return (
    <div class="backup">
      <Button onClick={() => void exportFile()}>匯出 JSON</Button>
      <label>
        匯入 JSON
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) void importFile(file);
            e.currentTarget.value = '';
          }}
        />
      </label>
      {result && <p role="status">{result}</p>}
    </div>
  );
}

const PRIVACY_URL = 'https://github.com/yurenju/naruhodo-manga-translator/blob/main/PRIVACY.md';

/**
 * 資料使用說明（shared/data-consent.ts）：還沒同意就固定顯示在最上面，啟動前、從內建選單打開時都一樣。
 * 內容要跟 PRIVACY.md 一致；資料處理方式改了，兩邊一起改，並把 DATA_CONSENT_VERSION 加一。
 */
function DataConsentCard({ onAccept }: { onAccept: () => void }) {
  return (
    <section aria-label="資料使用說明">
      <Callout tone="warn">
        <p>
          <strong>翻譯前請先確認資料怎麼使用</strong>
        </p>
        <ul>
          <li>對話框偵測與文字辨識都在這台電腦上進行，不會上傳圖片，也不會送出網址。</li>
          <li>辨識出的日文文字、同一部作品前幾頁的原文與譯文、作品的譯名表，會用你的 API key 直接送到 Anthropic 翻譯。</li>
          <li>API key、翻譯快取與作品筆記只存在這台電腦。開發者沒有伺服器，收不到你的任何資料。</li>
        </ul>
        <p>
          詳見
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
            隱私權政策
          </a>
          。不同意也能使用，只會顯示原文與讀音。
        </p>
        <Button variant="primary" onClick={onAccept}>
          同意並啟用翻譯
        </Button>
      </Callout>
    </section>
  );
}

/** undefined＝還在讀。 */
function useDataConsent(): boolean | undefined {
  const [consented, setConsented] = useState<boolean | undefined>(undefined);
  useEffect(() => watchDataConsent(setConsented), []);
  return consented;
}

/**
 * 設定區（spec #27 第 5 節）：API key 存在外掛 origin 的 IndexedDB，只顯示末四碼。
 * side panel 自己讀寫 key；「測試連線」由 offscreen 讀 key 呼叫 API，訊息裡不帶 key。從 ⚙ 選單打開（#77）。
 */
function Settings({
  consented,
  onKeyChanged,
  onClose,
}: {
  consented: boolean | undefined;
  onKeyChanged: (hasKey: boolean) => void;
  onClose: () => void;
}) {
  /** undefined＝還在讀；''＝沒有 key */
  const [suffix, setSuffix] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [connection, setConnection] = useState<string | undefined>(undefined);

  useEffect(() => {
    void apiKeys.get().then((key) => setSuffix(key ? lastFour(key) : ''));
  }, []);

  async function save() {
    const key = draft.trim();
    if (!key) return;
    await apiKeys.set(key);
    setDraft('');
    setConnection(undefined);
    setSuffix(lastFour(key));
    onKeyChanged(true);
  }

  async function remove() {
    await apiKeys.delete();
    setSuffix('');
    setConnection(undefined);
    onKeyChanged(false);
  }

  async function test() {
    setConnection('測試中…');
    const r = await send<TestConnectionResponse>({ type: 'panel:testConnection' });
    setConnection(r.ok ? `連線成功（${r.model}）` : `連線失敗：${r.error}`);
  }

  return (
    <section aria-label="API key 與模型" class="settings">
      <div class="section-head">
        <h2>API key 與模型</h2>
        <Button variant="ghost" onClick={onClose}>
          關閉
        </Button>
      </div>
      {suffix === undefined ? null : suffix ? (
        <>
          <p>已設定 Claude API key（末四碼 {suffix}）</p>
          <div class="actions">
            <Button onClick={() => void test()}>測試連線</Button>
            <Button onClick={() => void remove()}>刪除</Button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Claude API key
            <input
              type="password"
              autocomplete="off"
              spellcheck={false}
              value={draft}
              onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            />
          </label>
          <Button variant="primary" type="submit">
            儲存
          </Button>
        </form>
      )}
      {connection && <p class="connection">{connection}</p>}
      {consented && (
        <div class="actions">
          <Button onClick={() => void revokeDataConsent()}>撤回資料使用同意</Button>
        </div>
      )}
      <Backup />
      <p class="hint">
        建議在 Anthropic Console 為這個外掛建立專用的 API key，並為它的 workspace 設定花費上限。key 只存在這台電腦的外掛裡，不會交給網頁，也不會出現在匯出檔。
      </p>
    </section>
  );
}

/** 底部狀態列（spec #27 第 8 節），文字由 view.ts 算好。 */
function StatusText({ status }: { status: OverallStatus }) {
  if (status?.kind === 'translating') return <Progress>翻譯中…</Progress>;
  return status ? <span>{status.text}</span> : null;
}

const PAGE_MODES: readonly SegmentOption<PageMode>[] = [
  { value: 'read', label: '閱讀', description: '頁面直接顯示中文' },
  { value: 'learn', label: '學習', description: '保留日文，滑過看讀音' },
];

/** 目前的 Page Mode 與切換函式；別的 side panel 切了也跟著變。只在 App 訂閱一次，往下傳。 */
function usePageMode(): [PageMode, (mode: PageMode) => void] {
  const [mode, setMode] = useState<PageMode>(DEFAULT_PAGE_MODE);
  useEffect(() => watchPageMode(setMode), []);
  const choose = (value: PageMode) => {
    setMode(value);
    void savePageMode(value);
  };
  return [mode, choose];
}

/**
 * Page Mode 切換（spec #70、#73）：全域設定，存在 chrome.storage.local；頁面上的 content script 自己聽變更。
 * 學習時頁面不擦字、不畫譯文，翻譯照常進行。
 */
function PageModeSwitch({ mode, choose }: { mode: PageMode; choose: (mode: PageMode) => void }) {
  return <SegmentedControl label="頁面模式" size="lg" options={PAGE_MODES} value={mode} onChange={choose} />;
}

/** 自動翻譯開關（spec #27 第 3.4、8 節；預設開）；關掉後翻頁只顯示快取，其他要按「翻譯此頁」。 */
function AutoTranslateToggle({ tabId }: { tabId: number }) {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    void send<AutoTranslateResponse>({ type: 'panel:getAutoTranslate', tabId }).then((r) => setEnabled(r.enabled));
  }, [tabId]);
  const toggle = (value: boolean) => {
    setEnabled(value);
    void send({ type: 'panel:setAutoTranslate', tabId, enabled: value });
  };
  return <Switch label="自動翻譯" description="翻頁就翻，關掉只顯示快取" checked={enabled} onChange={toggle} />;
}

const NEW_SERIES = '__new__';

/** 名稱輸入（新增 Series／改名）；送出空白不算。 */
function NameForm({ label, submit, initial = '', onDone }: { label: string; submit: string; initial?: string; onDone: (name: string | undefined) => void }) {
  const [name, setName] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onDone(name.trim());
      }}
    >
      <input aria-label={label} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      <Button variant="primary" type="submit">
        {submit}
      </Button>
      <Button onClick={() => onDone(undefined)}>取消</Button>
    </form>
  );
}

/** 鉛筆圖示（改系列名稱）。 */
function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

/**
 * 底部列的系列（spec #27 第 8 節、#36、#77）：平常只是一行「系列＋名稱（過長截斷）＋鉛筆」；點鉛筆才展開編輯區：
 * 改名、切換 Series（最近用過的在最上面、Provisional Series 顯示為「未歸類」、「新增 Series…」）、
 * 把 Provisional Series 合併進既有 Series。
 */
function SeriesPicker({ tabId }: { tabId: number }) {
  const [series, setSeries] = useState<SeriesResponse | undefined>(undefined);
  /** undefined＝收起；rename＝鉛筆打開的編輯區；new＝在編輯區選了「新增 Series…」 */
  const [editing, setEditing] = useState<'new' | 'rename' | undefined>(undefined);
  const [mergeTarget, setMergeTarget] = useState('');

  useEffect(() => {
    const refresh = () => void send<SeriesResponse>({ type: 'panel:getSeries', tabId }).then(setSeries);
    const onMessage = (message: Message) => {
      if ((message.type === 'series:changed' || message.type === 'status:changed') && message.tabId === tabId) refresh();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    refresh();
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [tabId]);

  if (!series?.current) return null;
  const current = series.options.find((o) => o.id === series.current);
  const targets = series.options.filter((o) => !o.provisional && o.id !== series.current);
  const choose = (value: string) => {
    if (value === NEW_SERIES) setEditing('new');
    else {
      setEditing(undefined);
      void send({ type: 'panel:selectSeries', tabId, seriesId: value });
    }
  };
  const label = current?.label ?? '';
  return (
    <>
      <div role="group" aria-label="系列" class="series-row">
        <span class="series-row__label" aria-hidden="true">
          系列
        </span>
        <span class="series-row__name" title={label}>
          {label}
        </span>
        <Button
          variant="icon"
          aria-label="改系列名稱"
          aria-expanded={editing !== undefined}
          onClick={() => setEditing(editing === undefined ? 'rename' : undefined)}
        >
          <PencilIcon />
        </Button>
      </div>
      {editing !== undefined && (
        <section aria-label="編輯系列" class="series-editor">
          {editing === 'rename' && (
            <NameForm
              label="新名稱"
              submit="儲存"
              initial={current?.provisional ? '' : current?.name}
              onDone={(name) => {
                setEditing(undefined);
                if (name) void send({ type: 'panel:renameSeries', tabId, name });
              }}
            />
          )}
          <label class="series-editor__field">
            切換 Series
            <select aria-label="Series" value={editing === 'new' ? NEW_SERIES : series.current} onChange={(e) => choose(e.currentTarget.value)}>
              {series.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
              <option value={NEW_SERIES}>新增 Series…</option>
            </select>
          </label>
          {editing === 'new' && (
            <NameForm
              label="Series 名稱"
              submit="建立"
              onDone={(name) => {
                setEditing(undefined);
                if (name) void send({ type: 'panel:createSeries', tabId, name });
              }}
            />
          )}
          {current?.provisional && targets.length > 0 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!mergeTarget) return;
                setEditing(undefined);
                void send({ type: 'panel:mergeSeries', tabId, targetId: mergeTarget });
              }}
            >
              <select aria-label="合併進" value={mergeTarget} onChange={(e) => setMergeTarget(e.currentTarget.value)}>
                <option value="">合併進…</option>
                {targets.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <Button type="submit">合併</Button>
            </form>
          )}
        </section>
      )}
    </>
  );
}

/** 標題：logo（跟外掛 icon 同一份 SVG 母檔）＋名稱。 */
function Title() {
  return (
    <h1 class="title">
      <img src="icons/naruhodo.svg" alt="" width={24} height={24} />
      Naruhodo
    </h1>
  );
}

/** 齒輪圖示（⚙ 選單）。 */
function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

/** ⚙ 選單的一項；說明不算進按鈕的 accessible name（同 SegmentedControl 的副標）。 */
function MenuItem({ label, description, onClick }: { label: string; description?: string; onClick: () => void }) {
  const id = useId();
  return (
    <button type="button" class="panel-menu__item" aria-describedby={description ? id : undefined} onClick={onClick}>
      <span>{label}</span>
      {description && (
        <span id={id} class="panel-menu__desc" aria-hidden="true">
          {description}
        </span>
      )}
    </button>
  );
}

/** 從 ⚙ 選單打開、顯示在頂部下面的區塊。 */
type PanelSection = 'notes' | 'settings';

/**
 * 頂部的 ⚙ 選單（spec #70、#77）：不常用的功能收在這裡。點外面或按 Esc 收起；按了一項（開關以外）也收起。
 * 沒有啟動的 tab 時只有「API key 與模型」。
 */
function PanelMenu({ tabId, onOpen }: { tabId: number | undefined; onOpen: (section: PanelSection) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    // 焦點在 ⚙ 或選單裡時按 Esc 收起
    <div class="panel-menu" ref={root} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <Button variant="icon" aria-label="設定" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)}>
        <GearIcon />
      </Button>
      {open && (
        <div id={menuId} role="group" aria-label="設定選單" class="panel-menu__popover">
          {tabId !== undefined && (
            <>
              <div class="panel-menu__switch">
                <AutoTranslateToggle tabId={tabId} />
              </div>
              {/* 翻頁會自動偵測（#34）；這項給偵測漏掉時手動補一次。 */}
              <MenuItem label="重新擷取頁面" description="翻頁沒被偵測到時用" onClick={choose(() => void send({ type: 'panel:scan', tabId }))} />
              <MenuItem label="Series Notes" onClick={choose(() => onOpen('notes'))} />
            </>
          )}
          <MenuItem label="API key 與模型" onClick={choose(() => onOpen('settings'))} />
        </div>
      )}
    </div>
  );
}

function App({ tabId }: { tabId: number | undefined }) {
  // undefined＝還在問 SW
  const [active, setActive] = useState<boolean | undefined>(tabId === undefined ? false : undefined);
  const [pages, setPages] = useState<PageView[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ state: 'idle' });
  const [hasKey, setHasKey] = useState(true);
  const [level, setLevel] = useState<Level>(DEFAULT_LEVEL);
  const [furigana, setFurigana] = useState(true);
  const [pageMode, choosePageMode] = usePageMode();
  const display: Display = pageMode === 'learn' ? { mode: 'learn', furigana } : { mode: 'read', level };
  const [hovered, setHovered] = useState<TranscriptSync['hovered']>(undefined);
  const [section, setSection] = useState<PanelSection | undefined>(undefined);
  const consented = useDataConsent();

  useEffect(() => {
    void apiKeys.get().then((key) => setHasKey(Boolean(key)));
  }, []);

  useEffect(() => {
    if (tabId === undefined) return;
    const onMessage = (message: Message, sender: chrome.runtime.MessageSender) => {
      if (message.type === 'content:hover' && sender.tab?.id === tabId)
        setHovered(message.line ?? undefined);
      if (message.type === 'status:changed' && message.tabId === tabId) setActive(message.active);
      if (message.type === 'pages:updated' && message.tabId === tabId) setPages(message.pages);
      if (message.type === 'models:status') setModelStatus(message.status);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    void send<StatusResponse>({ type: 'panel:getStatus', tabId }).then((r) => setActive(r.active));
    void send<PagesResponse>({ type: 'panel:getPages', tabId }).then((r) => setPages(r.pages));
    void send<ModelStatusResponse>({ type: 'panel:getModelStatus' }).then((r) => setModelStatus(r.status));
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [tabId]);

  if (active === undefined) return null;
  const running = active && tabId !== undefined;
  const close = () => setSection(undefined);
  // 頂部只有 logo、名稱、狀態、停止、⚙（#77）；其餘收進 ⚙ 選單
  const header = (
    <div class="panel-header">
      <Title />
      {running && <Badge tone="ok">已啟動</Badge>}
      <span class="panel-header__spacer" />
      {running && (
        <Button variant="ghost" onClick={() => void send({ type: 'panel:stop', tabId })}>
          停止
        </Button>
      )}
      <PanelMenu tabId={running ? tabId : undefined} onOpen={(s) => setSection(section === s ? undefined : s)} />
    </div>
  );
  const settings = section === 'settings' && <Settings consented={consented} onKeyChanged={setHasKey} onClose={close} />;
  const consentCard = consented === false && <DataConsentCard onAccept={() => void grantDataConsent()} />;
  if (!running)
    return (
      <main>
        {header}
        {consentCard}
        <p>請點外掛圖示啟動</p>
        {settings}
      </main>
    );
  const scan = () => void send({ type: 'panel:scan', tabId });
  const done = pages.filter((p) => p.transcript.state === 'done');
  const pending = pages.some((p) => p.transcript.state === 'pending');
  const untranslated = pending || done.some((p) => p.transcript.state === 'done' && !p.transcript.translated);
  const translate = () => void send({ type: 'panel:translate', tabId });
  const view = sidePanelView(pages);
  const sync: TranscriptSync = {
    display,
    hovered,
    onLineHover(line) {
      chrome.tabs.sendMessage(tabId, { type: 'content:highlight', line } satisfies Message).catch(() => {});
    },
  };
  return (
    <>
      <main>
        {header}
        {consentCard}
        <PageModeSwitch mode={pageMode} choose={choosePageMode} />
        {settings}
        {section === 'notes' && <SeriesNotesSection tabId={tabId} onClose={close} />}
        <ModelStatusLine status={modelStatus} onRetry={scan} />
        {untranslated && !hasKey && (
          <Callout tone="warn">尚未設定 API key：只顯示原文與讀音（kuromoji 推測），未翻譯。請在 ⚙ 選單的「API key 與模型」輸入 key。</Callout>
        )}
        {done.length > 0 && <DisplaySwitch display={display} onLevel={setLevel} onFurigana={setFurigana} />}
        <ul aria-label="Page">
          {view.pages.map((entry) => (
            // 同一個 anchor 可能有兩個 Page（Spread），key 要帶 Page 身分
            <PageItem
              key={`${entry.page.anchorId}/${entry.page.pageHash}`}
              entry={entry}
              onRetry={translate}
              onRetranslate={() => void send({ type: 'panel:translate', tabId, pageHash: entry.page.pageHash })}
              sync={sync}
            />
          ))}
        </ul>
      </main>
      {/* 底部固定列；放在 main 外面才是 contentinfo landmark。兩行：系列一行、整體翻譯狀態＋翻譯按鈕一行（#77） */}
      <footer aria-label="狀態列">
        <SeriesPicker tabId={tabId} />
        <div class="status-row">
          <StatusText status={view.status} />
          {(done.length > 0 || pending) && (
            <Button variant={untranslated ? 'primary' : 'secondary'} onClick={translate}>
              {untranslated ? '翻譯此頁' : '重新翻譯'}
            </Button>
          )}
        </div>
      </footer>
    </>
  );
}

render(<App tabId={readTabId()} />, document.getElementById('app')!);
