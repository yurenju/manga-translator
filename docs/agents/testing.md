# Testing

Four layers. Run the cheapest one that covers your change; the slow ones only when they are needed. Why the layers are split this way: [ADR 0007](../adr/0007-browser-tests-fake-the-ocr-engine.md).

| Layer | Command | Browser + extension | OCR | LLM | When |
| --- | --- | --- | --- | --- | --- |
| unit | `npm test` | no | — | — | every change |
| browser test | `npm run test:browser` | real (mock site) | FakeEngine (replayed) | FakeTranslator | every change that touches the extension's behaviour |
| e2e | `npm run e2e` | real (mock site) | real models (wasm) | FakeTranslator | see below |
| smoke | `npm run smoke` | real (mock site) | real models | real Claude API | only when the Claude integration changes; costs money |

## Where a test goes

- Pure logic (geometry, parsing, reading order, Notes rules): **unit**, next to the module (`src/**/*.test.ts`).
- Anything that needs Chrome, the content script, the side panel or the mock site: **browser test**, in `browser/*.spec.ts`. This is the default for new Playwright tests.
- A browser test that is also one of the main end-to-end flows gets `{ tag: '@e2e' }`: it runs in both layers, with FakeEngine and with real OCR. Keep this set small (currently OCR accuracy, model download, the Jump+ overlay flow, the Kindle Spread flow, page turn, the Kindle toolbar).
- A test that only means something with real models (accuracy, model download) is tagged `@e2e` and calls `test.skip(fakeOcr, ...)`.

## When to run e2e

- Before opening the PR of an integration branch (implement-spec: once, after all tickets are merged, not in each ticket session).
- When a change touches `src/offscreen/` (models, OCR pipeline, Spread splitting, cropping).
- After `npm run record:ocr`.

Ticket sessions and ordinary changes run unit + browser test only.

## FakeEngine and the recording

Browser tests replace the ONNX models with FakeEngine (`src/offscreen/fake-engine.ts`). It recognises which synthetic page it was given by comparing thumbnails, then replays what the real models returned on that page: `testdata/synthetic/recorded-ocr.json`. So browser tests see the real models' boxes and text (including their mistakes), just without running them.

Re-record when the models, detection or OCR change: `npm run record:ocr`, then commit the JSON and run e2e. If FakeEngine throws "認不出這是哪張合成頁", the page it was given is not one of the recorded ranges (a new mock-site layout, or a crop the extension did not make before).

FakeEngine is near-instant. A test that relies on OCR being slow (queue scheduling, the side panel before the transcript arrives) sets `test.use({ fakeOcrDelayMs })`. Don't add a delay just to make a flaky test pass: instant OCR has already exposed a real product race on the mock Kindle (ADR 0007).

## Flaky tests

Browser tests have no retries: FakeEngine is deterministic, so a test that fails then passes points at a real race in the extension or the test. Fix it, or mark it `test.fixme(...)` with the reason and open an issue; do not add retries. e2e retries once, because real OCR speed depends on machine load.

Fixed delays follow [CODING_STANDARDS.md](../../CODING_STANDARDS.md): wait on a condition, except when asserting that something did *not* happen.
