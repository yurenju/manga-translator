import { Button } from './components.tsx';

/** 「訂閱」按鈕（side panel、設定頁、onboarding 共用）。沒給 onSubscribe（網站上的展示、還在讀方案）時停用。 */
export function SubscribeButton({ variant, onSubscribe }: { variant: 'primary' | 'link'; onSubscribe: (() => void) | undefined }) {
  return (
    <Button variant={variant} disabled={!onSubscribe} onClick={onSubscribe}>
      訂閱
    </Button>
  );
}
