# Site scope and deny list acceptance (#33)

Checked 2026-10-31 with Chrome for Testing 156.0.8078.47 and the isolated AnkiConnect instance at **127.0.0.1:8766**. No Anki writes were needed or performed.

`npm run build && npm test` passes (14 files, 120 tests). `npm run check:anki` passes: gateway status `ok`, read-only deck/type listing, and classification of a closed temporary port as `unreachable`. `npm run check:scope` passes against the built extension; machine-readable results and screenshots are in [site-scope-evidence](site-scope-evidence/).

## Behavior checked

- Fresh install grants only the existing loopback host permission. `activeTab` is selected by default; optional web hosts are not granted at installation.
- Wizard step 2 and Settings expose all three scope choices. Settings saves an edited deny list and includes the built-in mail, chat, and password-vault defaults.
- Remembered mode registers a persistent `content-auto.js` script only for granted, remembered, non-denied hosts. Permission checks also account for a remembered host covered by a broader grant.
- T-31 equivalent: an authorized, remembered `deny.localhost` fixture has no automatic drawer, but explicit `content.js` injection displays the drawer. `allow.localhost` runs automatically.
- Revoking the remembered origin through Chrome's extensions site-access backend removes its registration. Reloading the page no longer auto-runs.
- All-sites authorization registers `*://*/*`, matching the specification section 14 optional HTTP(S) host pattern. A new, unremembered host auto-runs; the denied fixture does not.
- Settings' revoke-all button removes the grant and registration; reloading no longer auto-runs.

Automatic injection asks the background to recheck the actual sender URL, scope, deny list, remembered sites, and current permission before creating any reading UI. Manual injection bypasses that auto-run guard. Permission, storage, startup, and install events reconcile persistent registrations.

## Limits and manual checks remaining

The native Chrome Allow/Deny permission bubble was **not automated**. The harness pre-authorizes hosts through Chrome's `developerPrivate` site-access backend, then invokes the real `chrome.permissions.request` from a trusted page-button click; this exercises an already-approved request, not a first-time native prompt. The actual toolbar click and its first-time remember request were not driven: the manual path uses the same `chrome.scripting.executeScript({files:["content.js"]})` call as the toolbar handler.

Real Gmail, Outlook, and messaging accounts were not opened. The deny-list behavior uses a local fixture added through the real editor; unit tests separately verify built-in Gmail and password-vault host matching. Installation prompt wording was not observed in native Chrome UI; the manifest/grants and the visible all-sites warning in Settings were checked. Protected Chrome pages and file URLs are outside automatic HTTP(S) reading scope. Native prompt acceptance/denial, a real toolbar-click permission request, and browser-restart persistence still need a human check.

Chrome's permission API requires requests to originate in a user gesture; see the [official permissions reference](https://developer.chrome.com/docs/extensions/reference/api/permissions). The toolbar starts the request before awaiting content injection, and Settings requests access directly from its grant button.
