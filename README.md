# VOKA

Chrome MV3 extension skeleton: TypeScript, Vite, a background AnkiConnect v1 gateway, a minimal options page, and a collapsed Shadow DOM drawer. Use Node 22.12+, 24+, or 26+ (matching the package engine range). Requires Anki ≥ 26.08 with the new AnkiConnect add-on (2055492159).

```sh
npm install
npm run build
npm test
```

Load `dist/` with **Load unpacked** at `chrome://extensions` (Developer mode). Installation opens the three-step onboarding wizard: connect Anki, choose learning settings, then preview a level import or skip it. Opening the wizard immediately checks the saved port once (default 8765) and shows the sequential results in step ①. If you use the disposable test instance, change the port to 8766 and click 重新检测. There is no polling: only 重新检测 or a page reload checks again. Subsequent Options visits also check the saved port once. Options keeps the same connection, learning, import and source-attribution sections on a single page.

Run `npx tsx scripts/check-onboarding.ts` after building for Chrome for Testing acceptance against isolated Anki 8766 and local diagnostic mocks. The script seeds port 8766 in the extension service worker before the install-time wizard opens, so the run never requests 8765, and verifies auto-check on open (including an unreachable saved port), sequential guidance, the mocked permission request path, persisted learning settings and computed counts. It retains screenshots under `docs/research/onboarding-evidence/` and does not modify the real instance's configuration or import notes.

Visit an ordinary HTTP(S) page and click the VOKA toolbar icon. A collapsed drawer shows the connection summary. If unavailable, fix Anki/settings and click Retry. Protected Chrome pages cannot be injected. There is no polling or automatic retry. Rebuild and reload the extension after source changes; reload the web page to replace an already injected script.

Only the background service worker makes Anki requests. API keys stay in `chrome.storage.local` and are sent as Bearer credentials to loopback. Checks use `api.describe` and require the spec section 6 methods to be advertised as available. Failure classes distinguish unreachable, incompatible API, forbidden origin (403), and authentication. Mutation transport failures have an unknown outcome and are never retried; the Options-only import route performs explicit user-confirmed writes.

## Isolated integration check

Start `~/VOKA-anki-test/launch.sh` if needed, then:

```sh
npm run check:anki
```

This explicitly targets **127.0.0.1:8766**, verifies `ok`, reads decks and note types, and checks a temporarily allocated closed port classifies as `unreachable`. It never requests 8765 or writes Anki data. Unit tests mock fetch and do not require Anki. UI text uses Chrome i18n catalogs in `public/_locales/zh_CN` and `en`, with Chinese as the default locale.

## English data and B1 import

After saving the isolated port **8766**, use **Preview import** in Options. The production pack uses official CEFR-J 1.6 and the separate Octanove C1/C2 1.0 dataset, OEWN 2025 definitions, and CMUdict US IPA. B1 contains 2,085 unique canonical lemmas. Native glosses are empty pending #28–#30. Options lists all data attributions and complete notices. The preview reads Anki only and shows new, existing, conflicting and skipped counts, target deck/type status, and source/version. Confirm is enabled only when new notes remain.

Confirmation provisions missing targets, verifies the exact 15-field order, validates notes, submits only valid notes with `atomic:false`, and reads back by Key. Existing notes/cards are never updated. Field mismatches stop the import instead of editing structure. Transport failures never trigger automatic write retries: the importer reads back and reports unresolved Keys. Run Preview again to inspect remaining notes after a failure.

```sh
npm run check:import                    # creates a uniquely named test type/deck and 12 notes
npm run check:import -- --existing-type  # provisions type first, then checks importing with an existing type
npm run check:import -- --default        # uses product targets; preserves existing fixture Keys
```


## Reading highlights

Click the toolbar icon on an English page after connecting Anki. Reading uses real CEFR-J/Octanove levels, OEWN definitions and WordNet morphology, with background batch lookups (`achieved → achieve`, `abandoning → abandon`). Target words are yellow, learning blue, manual unknown red, and optional advanced words pale yellow. Manual known and mature review cards have no highlight. Hover shows the headword and a gloss from the Anki note, or OEWN if no note exists; missing dictionary lemmas show the localized “词典没有” marker. Excluded input/editable/code/navigation/hidden regions are never processed. Dynamic changes use incremental per-block processing in yielded batches with session-only Key caching; no word wrapper spans are inserted.

Shared preferences are flat `chrome.storage.local` keys: `nativeLanguage` (`zh` default), `glossLanguage` (`native`), `targetLevel` (`B1`), `showAdvanced` (`false`), and `hoverScope` (`highlighted`). The reading script refreshes after preference/connection changes and a repeated toolbar click. Failed gateway work clears highlights and tooltip; Retry can restore them, with no background polling.

Run `npx puppeteer browsers install chrome`, then `npm run check:data:browser` for the real-pack read-only 8766 browser acceptance check. `npm run check:highlight` additionally checks exclusions, manual states, dynamic text and reconnection against the real levels, using only the small fixture import. This check uses the existing import flow and temporarily changes/restores two fixture notes' ManualStatus fields. See [acceptance evidence and limitations](docs/research/highlight-acceptance.md).
These fixture integration checks explicitly pass the small synthetic test pack (12 B1 notes), while the product always loads the real packs. They only contact `127.0.0.1:8766` and retain their artifacts for inspection. They assert fields/tags/hashes/templates, a second preview with zero new notes (the UI's disabled-confirm condition), unchanged card data on repeat, and unchanged `col.scm`, existing scheduling and review history using a read-only copy of the isolated SQLite collection. They do not drive Anki reviews; T-05 is checked by read-only state/history comparison, not by reviewing newly imported cards.

## Rebuild offline data

Generated packs in `public/data/` are committed, separately licensed JSON files; `npm run build` copies them unchanged and requires no data downloads. Regenerate with Python 3.10+ and network access:

```sh
npm run data:build
npm run check:data  # production B1 preview only; fixed 8766, no writes
```

The pipeline verifies every download against `tools/data/sources.json` SHA-256 pins, caches upstream bytes in ignored `.cache/data/`, and prints per-level counts and raw/gzip sizes. See [pipeline details](tools/data/README.md) and [acceptance evidence](docs/research/data-pipeline-acceptance.md).

`npm run check:dynamic` verifies React append/replace/remove and scroll behavior; see [dynamic-page measurements](docs/research/dynamic-pages-acceptance.md).
