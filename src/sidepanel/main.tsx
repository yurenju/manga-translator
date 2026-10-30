import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { indexedDbApiKeyStore, lastFour } from '../shared/api-key-store.ts';
import { grantDataConsent, revokeDataConsent, watchDataConsent } from '../shared/data-consent.ts';
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
import { Button, Switch } from '../ui/components.tsx';
import { SidePanel } from '../ui/side-panel.tsx';
import { SeriesNotesSection } from './series-notes.tsx';

/**
 * 點圖示啟動時，SW 用 sidepanel.html?tabId=N 打開這個 tab 專屬的 side panel。
 * 從 Chrome 內建 side panel 選單打開的沒有 tabId，也沒有 activeTab，只能提示去點圖示。
 */
function readTabId(): number | undefined {
  const raw = new URLSearchParams(location.search).get('tabId');
  return raw === null ? undefined : Number(raw);
}

const send = <R,>(message: Message) => chrome.runtime.sendMessage<Message, R>(message);

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

/**
 * 外掛的 container（#108）：接 chrome 訊息、API key、同意狀態與 Page Mode 的 store，把資料交給純畫面的 SidePanel。
 * 會讀寫 store 的區塊（設定、Series Notes、系列、自動翻譯開關）也在這裡，以 slot 交給 SidePanel。
 */
function App({ tabId }: { tabId: number | undefined }) {
  // undefined＝還在問 SW
  const [active, setActive] = useState<boolean | undefined>(tabId === undefined ? false : undefined);
  const [pages, setPages] = useState<PageView[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ state: 'idle' });
  const [hasKey, setHasKey] = useState(true);
  const [pageMode, choosePageMode] = usePageMode();
  const [hovered, setHovered] = useState<LineRef | undefined>(undefined);
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
  // 停止、擷取、翻譯、逐字稿 hover 只在 running（有 tabId）時出現，所以 tabId! 是安全的
  return (
    <SidePanel
      running={running}
      pages={pages}
      modelStatus={modelStatus}
      hasKey={hasKey}
      consented={consented}
      pageMode={pageMode}
      hovered={hovered}
      logoSrc="icons/naruhodo.svg"
      onPageModeChange={choosePageMode}
      onStop={() => void send({ type: 'panel:stop', tabId: tabId! })}
      onScan={() => void send({ type: 'panel:scan', tabId: tabId! })}
      onTranslate={(pageHash) => void send({ type: 'panel:translate', tabId: tabId!, ...(pageHash === undefined ? {} : { pageHash }) })}
      onLineHover={(line) => {
        chrome.tabs.sendMessage(tabId!, { type: 'content:highlight', line } satisfies Message).catch(() => {});
      }}
      onAcceptConsent={() => void grantDataConsent()}
      autoTranslate={running && <AutoTranslateToggle tabId={tabId} />}
      series={running && <SeriesPicker tabId={tabId} />}
      renderSettings={(close) => <Settings consented={consented} onKeyChanged={setHasKey} onClose={close} />}
      renderNotes={(close) => tabId !== undefined && <SeriesNotesSection tabId={tabId} onClose={close} />}
    />
  );
}

render(<App tabId={readTabId()} />, document.getElementById('app')!);
