# Site scope cold-start recovery (#56)

When a toolbar action arrives before the worker's scope cache is ready, manual
injection still happens immediately. Afterward, the background reads the saved
scope. In remembered mode, a missing host grant opens `remember.html?host=…`,
a small extension-origin confirmation tab. Its own button calls
`chrome.permissions.request` synchronously and reuses `rememberSite` to persist
the host and synchronize registrations. A grant already present records the
host without showing a prompt. The warm-cache fast path is unchanged.

The tab is deliberately simpler than an embedded extension iframe: there are no
`web_accessible_resources`, no page-message permission bridge, and no new required
or install-time permissions. The trade-off is a tab switch for the cold-cache
recovery case; the user closes it to return to reading. Denied permission can be
retried. The editable deny list continues to suppress only automatic runs.

## Validation

- `npm run build && npm test`: passed, 16 files / 128 tests. Cold-cache coverage
  includes remembered/ungranted, activeTab, warm cache, and already granted.
- `npm run check:scope`: passed on Chrome for Testing 156.0.8078.47, against
  isolated Anki 8766; existing registration/revocation/deny-list checks pass.
- `npm run check:anki`: passed, read-only `api.describe`, decks and note types on
  127.0.0.1:8766 plus unreachable-port classification. No Anki writes.
- `npx tsx scripts/check-scope-cold-start.ts`: passed. It closes the actual worker
  and detaches the debugger, verifies its target disappears, wakes a new worker,
  and invokes the actual toolbar listener. It observes manual injection and the
  confirmation tab, clicks the product button with a trusted mouse event, checks
  persisted host/registration, reloads the fixture, and observes automatic reading.

The cold-start harness copies `dist` to a temporary directory and delays only
its startup scope snapshot by 60 seconds to force the race. It captures the
actual action listener for toolbar-equivalent invocation. A temporary host grant
stands in for activeTab injection access and is removed immediately after
injection, before the recovery permission check. The native Allow/Deny dialog is
not automated: Chrome's developerPrivate backend preauthorizes the origin before
the real product button requests it. An actual icon click waking a stopped worker
and native permission denial remain manual checks; the attempted CDP action
command did not reliably wake the worker in this environment.

Evidence: [results](site-scope-cold-start-evidence/results.json) and
[confirmation screenshot](site-scope-cold-start-evidence/confirmed.png).
