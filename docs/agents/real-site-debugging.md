# Real-site debugging

How to debug the extension on a real manga site (Jump+, Kindle), where the e2e mock site cannot reproduce the problem. The user drives the browser; you read a **trace** of everything the pipeline did. Windows only.

The trace covers, per Page: page-turn signals → Page candidates (with why the rest were rejected) → capture → crop and Page hash → cache hit/miss → detection and OCR → LLM request/response → overlay layout, and every way the overlay hides or reattaches. Console warnings, errors and uncaught exceptions from the extension's own contexts are recorded too.

## Steps

1. **Start the recorder** in a Terminal panel tab (it runs until Chrome closes): `npm run debug:chrome`. It builds the debug flavour to `%LOCALAPPDATA%\manga-translator\extension`, opens Chrome with its own profile and remote debugging, and records over CDP. If that Chrome is already open, it reloads the extension instead of launching.
2. **First run only, the user sets up the profile** (it persists): in that Chrome, `chrome://extensions` → Developer mode → Load unpacked → `%LOCALAPPDATA%\manga-translator\extension`; set the API key in the side panel; log in to the site. Hand these steps to the user, then wait.
3. **The user reproduces the bug**: refresh the manga tab, click the extension icon, read until the problem shows, and send a screenshot with what they expected. The content script only exists after the icon click, so nothing from the page is traced before it.
4. **Read the trace** (below) until you can name the record where behaviour departs from what the user expected.
5. **After a code change**, `npm run debug:reload` rebuilds and reloads the extension; the user then refreshes the tab and clicks the icon again (a reload orphans the old content script, and Chrome revokes `activeTab` on navigation).

## Reading the trace

Each recording is a session folder `%LOCALAPPDATA%\manga-translator\debug\<YYYYMMDD-HHmmss>\` holding `trace.jsonl` (one record per line) and `images/`. The latest 10 sessions are kept.

- `npm run debug:summary` prints event counts and a compact timeline of the latest session; pass a session name for another one, `--grep <event>` to filter. Each line starts with its line number in `trace.jsonl`: read that line for the full record (LLM text, rects, fit regions).
- Follow one Page by its `pageHash`. Offscreen `analyze` records carry only `anchorId`; link them through the `crop` record with the same `anchorId`.
- Match the user's screenshot by time and by the images: `capture` is the full screenshot (overlay hidden, so it never shows our translation), `crop` thumbnails are each Page, and `analyze` `detections` draws the detector output on the Page (blue = Balloon box, red = text box, green = Loose Text, numbers = reading order).
- Event names and their fields live at the call sites: `grep -rn "trace('" src`.

## Adding a trace

Get a tracer with `createTrace(ctx)` from `src/shared/trace.ts` and call it with an event name and a data object. It is a no-op outside the debug build and the build test keeps the trace code out of prod; wrap any work done only for the trace (extra measuring, building arrays) in `if (__DEBUG__)` so prod skips it too. A string value starting with `data:image/` is saved as a file in `images/`. Keep the API key out of trace data.

## Handling real pages

Screenshots of real sites stay in `%LOCALAPPDATA%` and never enter the repo. Delete a session folder once its bug is fixed. The debug Chrome listens on port 9222, so any local program can drive that profile while it is open.
