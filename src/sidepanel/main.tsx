import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { indexedDbApiKeyStore, lastFour } from '../shared/api-key-store.ts';
import type {
  LineRef,
  Message,
  ModelStatus,
  ModelStatusResponse,
  AutoTranslateResponse,
  OverlayResponse,
  PagesResponse,
  PageView,
  SeriesResponse,
  StatusResponse,
  TestConnectionResponse,
  TranslationInfo,
} from '../shared/messages.ts';
import { DEFAULT_LEVEL, LevelSwitch, Transcript, type Level } from './transcript.tsx';

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
        <div role="alert">
          <p>辨識模型無法使用：{status.message}</p>
          <button type="button" onClick={onRetry}>
            重試
          </button>
        </div>
      );
    default:
      return null;
  }
}

/** 「已翻譯」或「快取」・模型・秒數・費用（spec #27 第 8 節）；快取時是當初翻譯的模型與數字。 */
function TranslationStatusLine({ status }: { status: TranslationInfo }) {
  const label = status.source === 'cache' ? '快取' : '已翻譯';
  return (
    <p class="translation-status" role="status" aria-label="翻譯狀態">
      {label}・{status.model}・{(status.latencyMs / 1000).toFixed(1)} 秒・${status.usage.costUsd.toFixed(4)}
    </p>
  );
}

/** 學習模式的共用狀態：全域顯示層級與 hover 同步（#39）。 */
interface LearningProps {
  level: Level;
  /** 頁面上滑鼠所在的那句。 */
  hovered: LineRef | undefined;
  /** 滑過 panel 的某行 → 頁面上那句高亮；null＝離開。 */
  onLineHover: (line: LineRef | null) => void;
}

function PageItem({ page, index, onRetry, learning }: { page: PageView; index: number; onRetry: () => void; learning: LearningProps }) {
  const { transcript } = page;
  const { level, hovered, onLineHover } = learning;
  return (
    <li>
      <img src={page.thumbnail} alt={`Page ${index + 1}`} />
      {transcript.state === 'analyzing' && <p>辨識中…</p>}
      {transcript.state === 'pending' && <p class="hint">未翻譯（自動翻譯已關閉，按「翻譯此頁」）</p>}
      {transcript.state === 'error' && <p class="error">辨識失敗：{transcript.message}</p>}
      {transcript.state === 'done' && transcript.translation && !transcript.translating && !transcript.translateError && (
        <TranslationStatusLine status={transcript.translation} />
      )}
      {transcript.state === 'done' && transcript.translating && <p>翻譯中…</p>}
      {transcript.state === 'done' && transcript.translateError && (
        <div role="alert">
          <p class="error">翻譯失敗，改顯示 kuromoji 讀音：{transcript.translateError}</p>
          <button type="button" onClick={onRetry}>
            重試
          </button>
        </div>
      )}
      {transcript.state === 'done' && (
        <Transcript
          text={transcript.text}
          translated={transcript.translated}
          level={level}
          hoveredId={hovered?.pageHash === page.pageHash ? hovered.lineId : undefined}
          onHover={(lineId) => onLineHover(lineId === null ? null : { pageHash: page.pageHash, lineId })}
        />
      )}
    </li>
  );
}

const apiKeys = indexedDbApiKeyStore();

/**
 * 設定區（spec #27 第 5 節）：API key 存在外掛 origin 的 IndexedDB，只顯示末四碼。
 * side panel 自己讀寫 key；「測試連線」由 offscreen 讀 key 呼叫 API，訊息裡不帶 key。
 */
function Settings({ onKeyChanged }: { onKeyChanged: (hasKey: boolean) => void }) {
  const [open, setOpen] = useState(false);
  /** undefined＝還在讀；''＝沒有 key */
  const [suffix, setSuffix] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [connection, setConnection] = useState<string | undefined>(undefined);

  useEffect(() => {
    void apiKeys.get().then((key) => {
      setSuffix(key ? lastFour(key) : '');
      onKeyChanged(Boolean(key));
    });
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
    <>
      <button type="button" class="gear" aria-expanded={open} onClick={() => setOpen(!open)}>
        ⚙ 設定
      </button>
      {open && (
        <section aria-label="設定" class="settings">
          {suffix === undefined ? null : suffix ? (
            <>
              <p>已設定 Claude API key（末四碼 {suffix}）</p>
              <button type="button" onClick={() => void test()}>
                測試連線
              </button>
              <button type="button" onClick={() => void remove()}>
                刪除
              </button>
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
              <button type="submit">儲存</button>
            </form>
          )}
          {connection && <p class="connection">{connection}</p>}
          <p class="hint">
            建議在 Anthropic Console 為這個外掛建立專用的 API key，並為它的 workspace 設定花費上限。key 只存在這台電腦的外掛裡，不會交給網頁，也不會出現在匯出檔。
          </p>
        </section>
      )}
    </>
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
const dollars = (usd: number) => (Number.isNaN(usd) ? '費用未知' : `$${usd.toFixed(5)}`);

/** 底部狀態列（spec #27 第 8 節）：已翻譯・模型・秒數・費用。多個 Page 時加總。 */
function StatusText({ pages }: { pages: PageView[] }) {
  const done = pages.flatMap((p) => (p.transcript.state === 'done' ? [p.transcript] : []));
  if (done.some((t) => t.translating)) return <span>翻譯中…</span>;
  const infos = done.flatMap((t) => (t.translated && t.translation ? [t.translation] : []));
  if (infos.length === 0) return null;
  const models = [...new Set(infos.map((i) => i.model))].join('、');
  const latency = infos.reduce((sum, i) => sum + i.latencyMs, 0);
  const cost = infos.reduce((sum, i) => sum + i.usage.costUsd, 0);
  return (
    <span>
      已翻譯 {infos.length} 頁 · {models} · {seconds(latency)} · {dollars(cost)}
    </span>
  );
}

/** 原地覆蓋的開關（spec #27 第 8 節的底部列）；關掉只是藏起來，翻譯照常進行。 */
function OverlayToggle({ tabId }: { tabId: number }) {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    void send<OverlayResponse>({ type: 'panel:getOverlay', tabId }).then((r) => setEnabled(r.enabled));
  }, [tabId]);
  const toggle = (value: boolean) => {
    setEnabled(value);
    void send({ type: 'panel:setOverlay', tabId, enabled: value });
  };
  return (
    <label>
      <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.currentTarget.checked)} />
      覆蓋
    </label>
  );
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
  return (
    <label>
      <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.currentTarget.checked)} />
      自動翻譯
    </label>
  );
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
      <button type="submit">{submit}</button>
      <button type="button" onClick={() => onDone(undefined)}>
        取消
      </button>
    </form>
  );
}

/**
 * 底部列的 Series 下拉（spec #27 第 8 節、#36）：最近用過的在最上面、Provisional Series 顯示為「未歸類」、
 * 「新增 Series…」、改名、把 Provisional Series 合併進既有 Series。
 */
function SeriesPicker({ tabId }: { tabId: number }) {
  const [series, setSeries] = useState<SeriesResponse | undefined>(undefined);
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
    else void send({ type: 'panel:selectSeries', tabId, seriesId: value });
  };
  return (
    <div class="series">
      <select aria-label="Series" value={editing === 'new' ? NEW_SERIES : series.current} onChange={(e) => choose(e.currentTarget.value)}>
        {series.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
        <option value={NEW_SERIES}>新增 Series…</option>
      </select>
      {editing === undefined && (
        <button type="button" onClick={() => setEditing('rename')}>
          改名
        </button>
      )}
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
      {current?.provisional && targets.length > 0 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (mergeTarget) void send({ type: 'panel:mergeSeries', tabId, targetId: mergeTarget });
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
          <button type="submit">合併</button>
        </form>
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
  const [hovered, setHovered] = useState<LearningProps['hovered']>(undefined);

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

  const settings = <Settings onKeyChanged={setHasKey} />;
  if (active === undefined) return null;
  if (!active || tabId === undefined)
    return (
      <main>
        <p>請點外掛圖示啟動</p>
        {settings}
      </main>
    );
  const scan = () => void send({ type: 'panel:scan', tabId });
  const done = pages.filter((p) => p.transcript.state === 'done');
  const pending = pages.some((p) => p.transcript.state === 'pending');
  const untranslated = pending || done.some((p) => p.transcript.state === 'done' && !p.transcript.translated);
  const translate = () => void send({ type: 'panel:translate', tabId });
  const learning: LearningProps = {
    level,
    hovered,
    onLineHover(line) {
      chrome.tabs.sendMessage(tabId, { type: 'content:highlight', line } satisfies Message).catch(() => {});
    },
  };
  return (
    <>
      <main>
        <p>已啟動</p>
        <button type="button" onClick={() => void send({ type: 'panel:stop', tabId })}>
          停止
        </button>
        {/* 翻頁會自動偵測（#34）；這顆給偵測漏掉時手動補一次。 */}
        <button type="button" onClick={scan}>
          重新擷取
        </button>
        <OverlayToggle tabId={tabId} />
        <AutoTranslateToggle tabId={tabId} />
        {settings}
        <ModelStatusLine status={modelStatus} onRetry={scan} />
        {untranslated && !hasKey && <p class="hint">尚未設定 API key：只顯示原文與讀音（kuromoji 推測），未翻譯。請在「⚙ 設定」輸入 key。</p>}
        {done.length > 0 && <LevelSwitch level={level} onChange={setLevel} />}
        <ul aria-label="Page">
          {pages.map((page, i) => (
            // 同一個 anchor 可能有兩個 Page（Spread），key 要帶 Page 身分
            <PageItem key={`${page.anchorId}/${page.pageHash}`} page={page} index={i} onRetry={translate} learning={learning} />
          ))}
        </ul>
      </main>
      {/* 底部固定列；放在 main 外面才是 contentinfo landmark */}
      <footer aria-label="狀態列">
        <SeriesPicker tabId={tabId} />
        <StatusText pages={pages} />
        {(done.length > 0 || pending) && (
          <button type="button" onClick={translate}>
            {untranslated ? '翻譯此頁' : '重新翻譯'}
          </button>
        )}
      </footer>
    </>
  );
}

render(<App tabId={readTabId()} />, document.getElementById('app')!);
