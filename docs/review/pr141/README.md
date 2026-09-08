# PR #141 — REST state visual review

Actual SwiftUI views captured in an iPhone 17 simulator (iOS 26.5, portrait). All names and content are synthetic fixtures: Alex, Riley, Feed the cat,
Veggie tacos, Milk, and Lake afternoon. No household data is included.

**Before:** PR head `71a4ee2a` integrated with current main (including #133 and #140)
at `a18fe9e5`, with only model injection and the screenshot harness added. Its Today
fetchers retain the old optional-result behavior. **After:** the fixes in this PR.
Family, Approvals, and Photos already had their first migration in the before build;
those comparisons verify preservation while Today and the shared notice change.

Each surface has four states: pending first load; successful empty response; initial
HTTP 503 failure; and successful fixture load followed by HTTP 503. The stale scenario
keeps the last confirmed data visible. Capture time is the fixture's saved-data time.
Phone Today is scrollable; the images show the initial viewport, including its
approvals entry point and dinner card.

The opt-in `RestScreenshotTests` hosts the shipping views, injects fetch outcomes,
and exports XCTest attachments plus PNGs into the simulator app's
`Documents/RestScreenshots`. Set `WAFFLED_CAPTURE_REST=1` in the test runner environment
and run only `WaffledTests/RestScreenshotTests`. Ordinary test runs skip this harness.

## iPad capture status

The iPad before/after set remains outstanding. Three local iPad simulator attempts
failed before the Waffled test host started: a new iOS 26.5 device, an existing iOS
18.2 device (whose bootstatus explicitly reported Data Migration Failed), and a fresh
iOS 18.2 device. The iPhone suite and captures succeed on the same code. A shared
CoreSimulator service restart is awaiting approval because it stops unrelated running
simulators. No iPad screenshot or verification is claimed here.

## iPhone 17

### Today

| State | Before | After |
|---|---|---|
| First load | ![Today before — First load](before/iphone-today-loading.png) | ![Today after — First load](after/iphone-today-loading.png) |
| Successful empty response | ![Today before — Successful empty response](before/iphone-today-empty.png) | ![Today after — Successful empty response](after/iphone-today-empty.png) |
| Failed initial load (HTTP 503) | ![Today before — Failed initial load (HTTP 503)](before/iphone-today-initialFailure.png) | ![Today after — Failed initial load (HTTP 503)](after/iphone-today-initialFailure.png) |
| Failed refresh after a successful load | ![Today before — Failed refresh after a successful load](before/iphone-today-stale.png) | ![Today after — Failed refresh after a successful load](after/iphone-today-stale.png) |

### Family

| State | Before | After |
|---|---|---|
| First load | ![Family before — First load](before/iphone-family-loading.png) | ![Family after — First load](after/iphone-family-loading.png) |
| Successful empty response | ![Family before — Successful empty response](before/iphone-family-empty.png) | ![Family after — Successful empty response](after/iphone-family-empty.png) |
| Failed initial load (HTTP 503) | ![Family before — Failed initial load (HTTP 503)](before/iphone-family-initialFailure.png) | ![Family after — Failed initial load (HTTP 503)](after/iphone-family-initialFailure.png) |
| Failed refresh after a successful load | ![Family before — Failed refresh after a successful load](before/iphone-family-stale.png) | ![Family after — Failed refresh after a successful load](after/iphone-family-stale.png) |

### Approvals

| State | Before | After |
|---|---|---|
| First load | ![Approvals before — First load](before/iphone-approvals-loading.png) | ![Approvals after — First load](after/iphone-approvals-loading.png) |
| Successful empty response | ![Approvals before — Successful empty response](before/iphone-approvals-empty.png) | ![Approvals after — Successful empty response](after/iphone-approvals-empty.png) |
| Failed initial load (HTTP 503) | ![Approvals before — Failed initial load (HTTP 503)](before/iphone-approvals-initialFailure.png) | ![Approvals after — Failed initial load (HTTP 503)](after/iphone-approvals-initialFailure.png) |
| Failed refresh after a successful load | ![Approvals before — Failed refresh after a successful load](before/iphone-approvals-stale.png) | ![Approvals after — Failed refresh after a successful load](after/iphone-approvals-stale.png) |

### Photos

| State | Before | After |
|---|---|---|
| First load | ![Photos before — First load](before/iphone-photos-loading.png) | ![Photos after — First load](after/iphone-photos-loading.png) |
| Successful empty response | ![Photos before — Successful empty response](before/iphone-photos-empty.png) | ![Photos after — Successful empty response](after/iphone-photos-empty.png) |
| Failed initial load (HTTP 503) | ![Photos before — Failed initial load (HTTP 503)](before/iphone-photos-initialFailure.png) | ![Photos after — Failed initial load (HTTP 503)](after/iphone-photos-initialFailure.png) |
| Failed refresh after a successful load | ![Photos before — Failed refresh after a successful load](before/iphone-photos-stale.png) | ![Photos after — Failed refresh after a successful load](after/iphone-photos-stale.png) |
