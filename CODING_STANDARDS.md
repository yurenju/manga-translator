# Coding standards

Judgement rules a reviewer checks a change against. Each rule says what to look for and why.

## e2e waits on explicit conditions

When a Playwright test (browser test or e2e) waits for something inside the extension to happen, it waits on a condition: an e2e-build global (such as `__overlaidRecords`) or `expect.poll` on observable state. A fixed delay (`waitForTimeout`) belongs only in a test asserting that something did *not* happen within a window.

Why: two e2e tests in PR #51 waited 2 seconds and then counted captures; under parallel load the work took longer than 2 seconds and the tests flaked. Waiting on `__overlaidRecords` made them stable.

## A new browser test names what unit cannot catch

A new or extended test in `browser/*.spec.ts` comes with a stated reason (in the PR or the test's comment) for what it catches that a unit test cannot: messages between extension contexts, real layout, scrolling, page turns, screenshots, downloads. A test that checks a rule (an ordering, a status-line format, a cache decision, an edge case) belongs in unit; ask for it to move there, extracting a plain function if needed. Layering: [docs/agents/testing.md](docs/agents/testing.md).

Why: the spec #100 audit found browser tests re-checking rules unit already covered (capture rate, queue order, Notes carry-over), adding seconds and flakiness each, while some rules (Spread page order, backup leaving out the API key) were protected only by a browser test.

## A new `@e2e` tag names what the real models change

A test newly tagged `@e2e` comes with a stated reason for how real OCR models change its result (accuracy, model download, models running on downscaled or cropped screenshots, models reading toolbar text). If FakeEngine's replay gives the same result, the test stays a browser test.

Why: e2e runs real models on one worker and takes minutes; spec #100 found the page-turn test tagged `@e2e` although FakeEngine covers it fully.
