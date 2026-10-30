/**
 * 外掛與產品網站共用的畫面（#108）。這個目錄不碰 chrome.*、IndexedDB 或 store（index.test.ts 檢查）。
 * 樣式：src/shared/tokens.css、./components.css、./side-panel.css 三份一起載入；放進 shadow root 也完整。
 * 漫畫頁上的覆蓋層是 src/content/overlay.ts 的 createOverlay，同樣可以在一般網頁上獨立呼叫。
 */
export { SidePanel, type SidePanelProps } from './side-panel.tsx';
export { Badge, Button, Callout, PageHeader, Progress, RadioCard, RevealChip, SegmentedControl, Switch } from './components.tsx';
export { DisplaySwitch, Transcript } from './transcript.tsx';
export { SignIn, type SignInProps } from './sign-in.tsx';
export { sidePanelView } from './view.ts';
