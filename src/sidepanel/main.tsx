import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Message, ModelStatus, ModelStatusResponse, PagesResponse, PageView, StatusResponse } from '../shared/messages.ts';
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
        const original = line.loose ? <em class="loose">🔊 {line.原文}</em> : <span class="original">{line.原文}</span>;
        return (
          <li key={line.id} data-kind={line.loose ? 'loose' : 'balloon'}>
            {original}
            <span class="reading" lang="ja">
              {line.讀音}
            </span>
            {translated && line.譯文 ? <span class="translation">{line.譯文}</span> : <span class="untranslated">未翻譯</span>}
          </li>
        );
      })}
    </ol>
  );
}

function PageItem({ page, index }: { page: PageView; index: number }) {
  const { transcript } = page;
  return (
    <li>
      <img src={page.thumbnail} alt={`Page ${index + 1}`} />
      {transcript.state === 'analyzing' && <p>辨識中…</p>}
      {transcript.state === 'error' && <p class="error">辨識失敗：{transcript.message}</p>}
      {transcript.state === 'done' && <Transcript text={transcript.text} translated={transcript.translated} />}
    </li>
  );
}

function App({ tabId }: { tabId: number | undefined }) {
  // undefined＝還在問 SW
  const [active, setActive] = useState<boolean | undefined>(tabId === undefined ? false : undefined);
  const [pages, setPages] = useState<PageView[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ state: 'idle' });

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

  if (active === undefined) return null;
  if (!active || tabId === undefined) return <p>請點外掛圖示啟動</p>;
  const scan = () => void send({ type: 'panel:scan', tabId });
  const untranslated = pages.some((p) => p.transcript.state === 'done' && !p.transcript.translated);
  return (
    <main>
      <p>已啟動</p>
      <button type="button" onClick={() => void send({ type: 'panel:stop', tabId })}>
        停止
      </button>
      {/* 翻頁偵測（#34）之前，捲動或翻頁後要手動重新擷取。 */}
      <button type="button" onClick={scan}>
        重新擷取
      </button>
      <ModelStatusLine status={modelStatus} onRetry={scan} />
      {/* API key 設定在 #31 */}
      {untranslated && <p class="hint">尚未設定 API key：只顯示原文與讀音（kuromoji 推測），未翻譯。</p>}
      <ul aria-label="Page">
        {pages.map((page, i) => (
          <PageItem key={page.anchorId} page={page} index={i} />
        ))}
      </ul>
    </main>
  );
}

render(<App tabId={readTabId()} />, document.getElementById('app')!);
