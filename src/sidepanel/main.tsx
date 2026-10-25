import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Message, StatusResponse } from '../shared/messages.ts';

/**
 * 點圖示啟動時，SW 用 sidepanel.html?tabId=N 打開這個 tab 專屬的 side panel。
 * 從 Chrome 內建 side panel 選單打開的沒有 tabId，也沒有 activeTab，只能提示去點圖示。
 */
function readTabId(): number | undefined {
  const raw = new URLSearchParams(location.search).get('tabId');
  return raw === null ? undefined : Number(raw);
}

const send = <R,>(message: Message) => chrome.runtime.sendMessage<Message, R>(message);

function App({ tabId }: { tabId: number | undefined }) {
  // undefined＝還在問 SW
  const [active, setActive] = useState<boolean | undefined>(tabId === undefined ? false : undefined);

  useEffect(() => {
    if (tabId === undefined) return;
    const onMessage = (message: Message) => {
      if (message.type === 'status:changed' && message.tabId === tabId) setActive(message.active);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    void send<StatusResponse>({ type: 'panel:getStatus', tabId }).then((r) => setActive(r.active));
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [tabId]);

  if (active === undefined) return null;
  if (!active || tabId === undefined) return <p>請點外掛圖示啟動</p>;
  return (
    <main>
      <p>已啟動</p>
      <button type="button" onClick={() => void send({ type: 'panel:stop', tabId })}>
        停止
      </button>
    </main>
  );
}

render(<App tabId={readTabId()} />, document.getElementById('app')!);
