/**
 * 「同意並登入」：email 驗證碼登入（#91 畫面定案）。先列資料流向，按「同意並寄送驗證碼」就代表同意；寄出後換成輸入驗證碼。
 * 純畫面：寄送與驗證交給注入的 HostedAuth，同意與存 session 交給 callback。用在 onboarding（#93）的第 2 步；
 * 資料流向的文字在 data-flow.tsx。
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { HostedErrorReason } from '../shared/hosted-api.ts';
import type { HostedAuth } from '../shared/hosted-auth.ts';
import { Button, Callout } from './components.tsx';
import { HostedDataFlow, PolicyLinks } from './data-flow.tsx';

/** 寄出後 30 秒內不能重新寄送（Worker 另外依 IP 與 email 限制頻率）。 */
const RESEND_COOLDOWN_S = 30;

const ERRORS: Partial<Record<HostedErrorReason, string>> = {
  rateLimited: '寄送太頻繁了，請過幾分鐘再試。',
  wrongCode: '驗證碼不正確，請再確認一次。',
  codeExpired: '驗證碼已經過期，請重新寄送。',
  tooManyAttempts: '錯誤次數太多，這組驗證碼已失效，請重新寄送。',
};

/** 這組驗證碼已經不能用：欄位與「登入」停用，只能重新寄送。 */
const LOCKED: (HostedErrorReason | undefined)[] = ['codeExpired', 'tooManyAttempts'];

interface Failure {
  reason: HostedErrorReason | undefined;
  message: string;
}

const errorText = (failure: Failure, fallback: string) => (failure.reason && ERRORS[failure.reason]) ?? `${fallback}：${failure.message}`;

function ErrorCallout({ text }: { text: string | undefined }) {
  return text ? (
    <Callout tone="danger" role="alert">
      <p>{text}</p>
    </Callout>
  ) : null;
}

/** 剩幾秒可以重新寄送；0＝可以了。 */
function useCountdown(): [number, () => void] {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  useEffect(() => {
    if (left === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [left > 0]);
  const start = () => {
    setNow(Date.now());
    setUntil(Date.now() + RESEND_COOLDOWN_S * 1000);
  };
  return [left, start];
}

export interface SignInProps {
  auth: HostedAuth;
  /** 按「同意並寄送驗證碼」：記下資料使用同意（在寄送之前）。 */
  onConsent: () => void | Promise<void>;
  /** 驗證成功：存 session。 */
  onSignedIn: (session: { token: string; email: string }) => void | Promise<void>;
  /** 只在輸入 email 時顯示的內容（onboarding 的「← 上一步」；輸入驗證碼時沒有）。 */
  emailFooter?: ComponentChildren;
}

export function SignIn({ auth, onConsent, onSignedIn, emailFooter }: SignInProps) {
  /** undefined＝還在輸入 email；有值＝驗證碼寄到這個 email 了。 */
  const [sentTo, setSentTo] = useState<string | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [resendIn, startCooldown] = useCountdown();

  async function send(to: string) {
    setBusy(true);
    const result = await auth.sendCode(to);
    setBusy(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    setFailure(undefined);
    setCode('');
    setSentTo(to);
    startCooldown();
  }

  async function verify(to: string) {
    setBusy(true);
    const result = await auth.verifyCode(to, code.trim());
    if (result.ok) await onSignedIn({ token: result.token, email: to });
    else setFailure(result);
    setBusy(false);
  }

  if (sentTo === undefined)
    return (
      <section aria-label="同意並登入" class="sign-in">
        <h3>同意並登入</h3>
        <p>翻譯前，先確認資料怎麼使用：</p>
        <HostedDataFlow />
        <p class="hint">
          <PolicyLinks />
        </p>
        <ErrorCallout text={failure && errorText(failure, '寄送失敗')} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const to = email.trim();
            if (!to) return;
            void Promise.resolve(onConsent()).then(() => send(to));
          }}
        >
          <label>
            Email
            <input type="email" autocomplete="email" required value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
          </label>
          <Button variant="primary" type="submit" disabled={busy}>
            同意並寄送驗證碼
          </Button>
        </form>
        <p class="hint">不用設定密碼：每次登入都用寄到信箱的驗證碼，登入後會一直保持登入。</p>
        {emailFooter}
      </section>
    );

  const locked = LOCKED.includes(failure?.reason);
  return (
    <section aria-label="輸入驗證碼" class="sign-in">
      <h3>輸入驗證碼</h3>
      <p>
        我們寄了一封含 6 位數驗證碼的信到 <strong>{sentTo}</strong>。沒看到的話，請找找垃圾郵件匣。
      </p>
      <ErrorCallout text={failure && errorText(failure, '登入失敗')} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) void verify(sentTo);
        }}
      >
        <label>
          驗證碼
          <input
            class="sign-in__code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength={6}
            placeholder="123456"
            disabled={locked}
            value={code}
            onInput={(e) => setCode(e.currentTarget.value)}
          />
        </label>
        <Button variant="primary" type="submit" disabled={locked || busy}>
          登入
        </Button>
      </form>
      <p class="naru-row">
        {resendIn > 0 ? (
          <span class="hint">{resendIn} 秒後可以重新寄送</span>
        ) : (
          <Button variant="link" disabled={busy} onClick={() => void send(sentTo)}>
            重新寄送驗證碼
          </Button>
        )}
        <span aria-hidden="true">・</span>
        <Button
          variant="link"
          onClick={() => {
            setSentTo(undefined);
            setFailure(undefined);
          }}
        >
          改用其他 email
        </Button>
      </p>
    </section>
  );
}
