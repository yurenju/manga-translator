import { Button } from './components.tsx';

/**
 * 「訂閱」按鈕（side panel、設定頁、onboarding 共用）。訂閱還沒開放（__SUBSCRIPTION_OPEN__：Paddle 審核還沒過，#97）時
 * 停用，改成「訂閱即將推出」；沒給 onSubscribe（網站上的展示、還在讀方案）也停用。
 */
export function SubscribeButton({ variant, onSubscribe }: { variant: 'primary' | 'link'; onSubscribe: (() => void) | undefined }) {
  if (!__SUBSCRIPTION_OPEN__)
    return (
      <Button variant={variant} disabled>
        訂閱即將推出
      </Button>
    );
  return (
    <Button variant={variant} disabled={!onSubscribe} onClick={onSubscribe}>
      訂閱
    </Button>
  );
}
