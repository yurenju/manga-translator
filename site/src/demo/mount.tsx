/** 首頁展示（#109）的進入點：把 Demo render 進 index.astro 的 [data-demo]，文案從 data-copy 讀（跟著網站語言）。 */
import { render } from 'preact';
import { Demo, type DemoCopy } from './Demo.tsx';

for (const element of document.querySelectorAll<HTMLElement>('[data-demo]')) {
  render(<Demo copy={JSON.parse(element.dataset.copy!) as DemoCopy} />, element);
}
