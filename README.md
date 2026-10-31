# VOKA

Chrome MV3 extension skeleton: TypeScript, Vite, a background AnkiConnect v1 gateway, a minimal options page, and a collapsed Shadow DOM drawer. Use Node 22.12+, 24+, or 26+ (matching the package engine range). Requires Anki ≥ 26.08 with the new AnkiConnect add-on (2055492159).

```sh
npm install
npm run build
npm test
```

Load `dist/` with **Load unpacked** at `chrome://extensions` (Developer mode). Open the extension's **Options**, set the AnkiConnect port and optional API key, and click **Save and check again**. The default port is 8765; for the disposable test instance, **set 8766 before clicking the toolbar action or running checks**. Opening Options checks the currently saved port. For isolated testing without ever contacting 8765: after loading, click the service worker **Inspect** link at `chrome://extensions`, run `await chrome.storage.local.set({port: 8766, apiKey: ""})` in its console, then open Options and use the toolbar.

Visit an ordinary HTTP(S) page and click the VOKA toolbar icon. A collapsed drawer shows the connection summary. If unavailable, fix Anki/settings and click Retry. Protected Chrome pages cannot be injected. There is no polling or automatic retry. Rebuild and reload the extension after source changes; reload the web page to replace an already injected script.

Only the background service worker makes Anki requests. API keys stay in `chrome.storage.local` and are sent as Bearer credentials to loopback. Checks use `api.describe` and require the spec section 6 methods to be advertised as available. Failure classes distinguish unreachable, incompatible API, forbidden origin (403), and authentication. Mutation transport failures have an unknown outcome and are never retried; this skeleton exposes no mutation message route.

## Isolated integration check

Start `~/VOKA-anki-test/launch.sh` if needed, then:

```sh
npm run check:anki
```

This explicitly targets **127.0.0.1:8766**, verifies `ok`, reads decks and note types, and checks a temporarily allocated closed port classifies as `unreachable`. It never requests 8765 or writes Anki data. Unit tests mock fetch and do not require Anki. UI text uses Chrome i18n catalogs in `public/_locales/zh_CN` and `en`, with Chinese as the default locale.
