# Coding standards

Judgement rules a reviewer checks a change against. Each rule says what to look for and why.

## e2e waits on explicit conditions

When an e2e test waits for something inside the extension to happen, it waits on a condition: an e2e global (such as `__overlaidRecords`) or `expect.poll` on observable state. A fixed delay (`waitForTimeout`) belongs only in a test asserting that something did *not* happen within a window.

Why: two e2e tests in PR #51 waited 2 seconds and then counted captures; under parallel load the work took longer than 2 seconds and the tests flaked. Waiting on `__overlaidRecords` made them stable.
