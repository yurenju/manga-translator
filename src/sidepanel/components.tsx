/**
 * side panel 的共用元件（spec #70「Design tokens 與元件」、#71）。樣式在 components.css，顏色與尺寸都取自
 * src/shared/tokens.css。class 前綴 naru-，只給樣式用；測試用 role／accessible name 找元素。
 */
import type { ButtonHTMLAttributes, ComponentChildren, HTMLAttributes } from 'preact';
import { useId } from 'preact/hooks';

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'icon';

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'class' | 'className'> & {
  /** primary：主要動作（一區最多一個）；secondary：預設；ghost：次要、工具列；icon：只有圖示，要給 aria-label。 */
  variant?: ButtonVariant;
  class?: string;
};

export function Button({ variant = 'secondary', type = 'button', class: extra, ...rest }: ButtonProps) {
  return <button type={type} class={cx('naru-btn', `naru-btn--${variant}`, extra)} {...rest} />;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** 大尺寸才顯示的一行副標；不算進按鈕的 accessible name（用 aria-describedby）。 */
  description?: string;
}

/**
 * 分段切換：一組 aria-pressed 的按鈕，外層是有名字的 group。
 * sm：一般選項（例如顯示層級）；lg：每格有標題與副標（例如 Page Mode）。
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  size = 'sm',
}: {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'lg';
}) {
  const id = useId();
  return (
    <div
      role="group"
      aria-label={label}
      class={cx('naru-seg', `naru-seg--${size}`)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o, i) => {
        const descId = size === 'lg' && o.description ? `${id}-${i}` : undefined;
        return (
          <button key={o.value} type="button" aria-pressed={o.value === value} aria-describedby={descId} onClick={() => onChange(o.value)}>
            <span class="naru-seg__label">{o.label}</span>
            {descId && (
              <span id={descId} class="naru-seg__desc">
                {o.description}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** 開關：原生 checkbox 加 role="switch"，鍵盤與表單行為照舊；label 就是它的 accessible name。 */
export function Switch({
  label,
  checked,
  onChange,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** 開關下面的一行說明。 */
  description?: string;
}) {
  const id = useId();
  return (
    <label class="naru-switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-describedby={description ? id : undefined}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span class="naru-switch__track" aria-hidden="true" />
      <span class="naru-switch__text">
        <span class="naru-switch__label">{label}</span>
        {description && (
          <span id={id} class="naru-switch__desc">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

/** 小標籤。neutral：一般；warn：推測、過期；sfx：狀聲詞；danger：失敗；ok：啟動狀態（膠囊＋圓點）。 */
export type BadgeTone = 'neutral' | 'warn' | 'sfx' | 'danger' | 'ok';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ComponentChildren }) {
  return (
    <span class={cx('naru-badge', `naru-badge--${tone}`)}>
      {tone === 'ok' && <span class="naru-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** 提示框。info：一般說明；warn：需要注意（過期、沒有 key）；danger：錯誤。role 等屬性原樣傳下去。 */
export type CalloutTone = 'info' | 'warn' | 'danger';

type CalloutProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'className'> & {
  tone?: CalloutTone;
  class?: string;
};

export function Callout({ tone = 'info', class: extra, ...rest }: CalloutProps) {
  return <div class={cx('naru-callout', `naru-callout--${tone}`, extra)} {...rest} />;
}
