import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { indexedDbApiKeyStore, lastFour } from '../shared/api-key-store.ts';
import type {
  Message,
  ModelStatus,
  ModelStatusResponse,
  PagesResponse,
  PageView,
  StatusResponse,
  TestConnectionResponse,
  TranslationInfo,
} from '../shared/messages.ts';
import type { PageText } from '../shared/page-text.ts';

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

/** 逐字稿：Balloon 與 Loose Text 依閱讀順序混在同一串；Loose Text 用斜體＋🔊（spec #27 第 8 節）。 */
function Transcript({ text, translated }: { text: PageText; translated: boolean }) {
  const lines = [
    ...text.balloons.map((b) => ({ ...b, loose: false })),
    ...text.looseText.map((l) => ({ ...l, loose: true })),
  ].sort((a, b) => a.order - b.order);
  return (
    <ol aria-label="逐字稿">
      {lines.map((line) => {
        // unreadable：OCR 原文（灰、刪除線）＋「無法辨識」（spec #27 第 8 節）
        const unreadable = translated && line.unreadable;
        const cls = unreadable ? ' unreadable' : '';
        const original = line.loose ? <em class={`loose${cls}`}>🔊 {line.原文}</em> : <span class={`original${cls}`}>{line.原文}</span>;
        return (
          <li key={line.id} data-kind={line.loose ? 'loose' : 'balloon'}>
            {original}
            {unreadable ? (
              <span class="unreadable-label">無法辨識</span>
            ) : (
              <>
                <span class="reading" lang="ja">
                  {line.讀音}
                </span>
                {translated && line.譯文 ? <span class="translation">{line.譯文}</span> : <span class="untranslated">未翻譯</span>}
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
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

function PageItem({ page, index }: { page: PageView; index: number }) {
  const { transcript } = page;
  return (
    <li>
      <img src={page.thumbnail} alt={`Page ${index + 1}`} />
      {transcript.state === 'analyzing' && <p>辨識中…</p>}
      {transcript.state === 'error' && <p class="error">辨識失敗：{transcript.message}</p>}
      {transcript.state === 'done' && transcript.translation && !transcript.translating && !transcript.translateError && (
        <TranslationStatusLine status={transcript.translation} />
      )}
      {transcript.state === 'done' && transcript.translating && <p>翻譯中…</p>}
      {transcript.state === 'done' && transcript.translateError && (
        <p class="error">翻譯失敗，改顯示 kuromoji 讀音：{transcript.translateError}</p>
      )}
      {transcript.state === 'done' && <Transcript text={transcript.text} translated={transcript.translated} />}
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

function App({ tabId }: { tabId: number | undefined }) {
  // undefined＝還在問 SW
  const [active, setActive] = useState<boolean | undefined>(tabId === undefined ? false : undefined);
  const [pages, setPages] = useState<PageView[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ state: 'idle' });
  const [hasKey, setHasKey] = useState(true);

  useEffect(() => {
    if (tabId === undefined) return;
    const onMessage = (message: Message) => {
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
  const untranslated = done.some((p) => p.transcript.state === 'done' && !p.transcript.translated);
  const translate = () => void send({ type: 'panel:translate', tabId });
  return (
    <>
      <main>
        <p>已啟動</p>
        <button type="button" onClick={() => void send({ type: 'panel:stop', tabId })}>
          停止
        </button>
        {/* 翻頁偵測（#34）之前，捲動或翻頁後要手動重新擷取。 */}
        <button type="button" onClick={scan}>
          重新擷取
        </button>
        {settings}
        <ModelStatusLine status={modelStatus} onRetry={scan} />
        {untranslated && !hasKey && <p class="hint">尚未設定 API key：只顯示原文與讀音（kuromoji 推測），未翻譯。請在「⚙ 設定」輸入 key。</p>}
        <ul aria-label="Page">
          {pages.map((page, i) => (
            <PageItem key={page.anchorId} page={page} index={i} />
          ))}
        </ul>
      </main>
      {/* 底部固定列；放在 main 外面才是 contentinfo landmark */}
      <footer aria-label="狀態列">
        <StatusText pages={pages} />
        {done.length > 0 && (
          <button type="button" onClick={translate}>
            {untranslated ? '翻譯此頁' : '重新翻譯'}
          </button>
        )}
      </footer>
    </>
  );
}

render(<App tabId={readTabId()} />, document.getElementById('app')!);
