# Real-site debugging

How to debug the extension on a real manga site (Jump+, Kindle), where the e2e mock site cannot reproduce the problem. The user drives the browser; you read a **trace** of everything the pipeline did. Windows only.

The trace covers, per Page: page-turn signals → Page candidates (with why the rest were rejected) → capture → crop and Page hash → cache hit/miss → detection and OCR → LLM request/response → overlay layout, and every way the overlay hides or reattaches. Console warnings, errors and uncaught exceptions from the extension's own contexts are recorded too.

## Steps

1. **Start the recorder** in a Terminal panel tab (it runs until Chrome closes): `npm run debug:chrome`. It builds the debug flavour to `%LOCALAPPDATA%\manga-translator\extension`, opens Chrome with its own profile and remote debugging, and records over CDP. If that Chrome is already open, it reloads the extension instead of launching.
2. **First run only, the user sets up the profile** (it persists): in that Chrome, `chrome://extensions` → Developer mode → Load unpacked → `%LOCALAPPDATA%\manga-translator\extension`; set the API key in the side panel; log in to the site. Hand these steps to the user, then wait.
3. **The user reproduces the bug**: refresh the manga tab, click the extension icon, read until the problem shows, and send a screenshot with what they expected. The content script only exists after the icon click, so nothing from the page is traced before it.
4. **Read the trace** (below) until you can name the record where behaviour departs from what the user expected.
5. **After a code change**, `npm run debug:reload` in a Terminal panel tab rebuilds and reloads the extension; the user then refreshes the tab and clicks the icon again (a reload orphans the old content script, and Chrome revokes `activeTab` on navigation).

Run both build commands in the Terminal panel: files the Bash and PowerShell tools write under `%LOCALAPPDATA%` stay invisible to the Terminal and to the Chrome it opened, while the Terminal's writes are visible to the tools. Reading traces, `debug:summary` and `debug:eval` all work from Bash.

## Reading the trace

Each recording is a session folder `%LOCALAPPDATA%\manga-translator\debug\<YYYYMMDD-HHmmss>\` holding `trace.jsonl` (one record per line) and `images/`. The latest 10 sessions are kept.

- `npm run debug:summary` prints event counts and a compact timeline of the latest session; pass a session name for another one, `--grep <event>` to filter, `--since <line>` to print only what was recorded after the last line you read. Each line starts with its line number in `trace.jsonl`: read that line for the full record. The timeline drops what is bulky: `crop` shows each Page as `anchorId:hash` plus `ms`, `overlay:show` shows only the fit count and whether any was truncated, and image paths are left out; LLM text, rects, fit regions and images are all in the full line.
- Follow one Page by its `pageHash`. Offscreen `analyze` records carry only `anchorId`; link them through the `crop` record with the same `anchorId`.
- Match the user's screenshot by time and by the images: `capture` is the full screenshot (overlay hidden, so it never shows our translation), `crop` thumbnails are each Page, and `analyze` `detections` draws the detector output on the Page (blue = Balloon box, red = text box, green = Loose Text, numbers = reading order).
- Event names and their fields live at the call sites: `grep -rn "trace('" src`.

## Measuring in real Chrome

Timing and performance bugs need measuring in the debug Chrome: e2e runs Playwright's Chromium, which is far faster at the steps that matter and cannot reproduce them. Known differences:

| | Real Chrome | Playwright Chromium |
| --- | --- | --- |
| `chrome.tabs.captureVisibleTab` | 0.2–1.7 s | ~80 ms |
| `OffscreenCanvas.convertToBlob` in the offscreen document | ~1 s | ~55 ms |
| `requestAnimationFrame` in the offscreen document | never fires | — |

`npm run debug:eval -- <sw|offscreen|page|content> <file.js>` (or `-e "<expression>"`) runs an awaitable expression in that context of the open debug Chrome and prints the result as JSON. `content` is the content script's isolated world in the manga tab; `page` is that tab's main world. It picks this extension's SW and offscreen document by manifest name, defines `activeTab()` in the SW (the manga tab: the extension has no `tabs` permission, so `chrome.tabs.query` shows no URLs), and gives up after `--timeout` seconds (default 30). The offscreen document exists only after the extension's first detection or translation, and the SW only while awake: click the icon first.

## Adding a trace

Get a tracer with `createTrace(ctx)` from `src/shared/trace.ts` and call it with an event name and a data object. It is a no-op outside the debug build and the build test keeps the trace code out of prod; wrap any work done only for the trace (extra measuring, building arrays) in `if (__DEBUG__)` so prod skips it too. A string value starting with `data:image/` is saved as a file in `images/`. Keep the API key out of trace data.

## Handling real pages

Screenshots of real sites stay in `%LOCALAPPDATA%` and never enter the repo. Delete a session folder once its bug is fixed. The debug Chrome listens on port 9222, so any local program can drive that profile while it is open.
