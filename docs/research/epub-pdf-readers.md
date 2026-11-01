# EPUB and PDF reader investigation

Issue [#73](https://github.com/xzpjerry/VOKA/issues/73), parent [#69](https://github.com/xzpjerry/VOKA/issues/69) · measured 2026-11-01

## Question 1 — EPUB library comparison

I compared browser entry points as isolated production bundles with esbuild 0.28.2, `--bundle --minify --format=esm --platform=browser --target=chrome120`, then measured gzip level 9 with a normalized timestamp. These are minified JavaScript bytes only, not npm tarball sizes or the surrounding reader UI. The PDF.js row includes its separate worker because it must ship with an extension build.

| Candidate | License | Release and activity (checked 2026-11-01) | Isolated minified JS, gzip | `eval` / `new Function` grep | Loading indicators and render approach |
| --- | --- | --- | ---: | --- | --- |
| [epub.js](https://github.com/futurepress/epub.js) 0.3.93 | [BSD-2-Clause](https://github.com/futurepress/epub.js/blob/master/license) | Stable npm 0.3.93 published 2022-02-16; npm's 0.5.0-alpha.3 was published 2023-09-26. Repository commits continue (latest checked 2026-03-24), but stable package releases are old. [npm versions](https://www.npmjs.com/package/epubjs), [repository history](https://github.com/futurepress/epub.js/commits/master) | 360,993 B (107,630 B gzip) | 0 / **1** | Grep found 3 `XMLHttpRequest` references and 15 absolute-URL strings; the library can request book resources by URL. It renders XHTML in iframes, with CSS multi-column pagination or scrolled flow, and supports CFI navigation. [README](https://github.com/futurepress/epub.js#readme) |
| [foliate-js](https://github.com/johnfactotum/foliate-js) 1.0.1 | [MIT](https://github.com/johnfactotum/foliate-js/blob/main/LICENSE) | npm 1.0.1 published 2025-04-21; repository activity through 2026-05-01 and issues through 2026. The README calls the API unstable. [npm](https://www.npmjs.com/package/foliate-js), [repository history](https://github.com/johnfactotum/foliate-js/commits/main), [README](https://github.com/johnfactotum/foliate-js#readme) | 177,004 B (61,949 B gzip) | 0 / 0 | Grep found 2 `fetch(` calls, no XHR references, and 31 absolute-URL strings. Its `<foliate-view>` uses a closed shadow root and its reflowable paginator uses an iframe; the library supports paginated and scrolled flow, section CFIs, and `goTo()`. [Rendering and location API](https://github.com/johnfactotum/foliate-js/blob/main/README.md) |
| [@readium/navigator](https://github.com/readium/ts-toolkit/tree/develop/navigator) 2.14.0 | [BSD-3-Clause](https://github.com/readium/ts-toolkit/blob/develop/LICENSE) | npm 2.14.0 published and repository updated 2026-10-23; active release and commit activity. [npm](https://www.npmjs.com/package/@readium/navigator), [repository history](https://github.com/readium/ts-toolkit/commits/develop) | 455,086 B (102,528 B gzip) | 0 / 0 | Grep found no `fetch(` or XHR references and 61 absolute-URL strings. The toolkit is a publication navigator/integration layer: the host supplies publication resources and embeds HTML/XHTML (commonly by iframe). A packaged local EPUB needs a publication/streaming adapter and integration with its companion packages. [Readium Web docs](https://readium.org/ts-toolkit/) |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) 6.4.299 | [Apache-2.0](https://github.com/mozilla/pdf.js/blob/master/LICENSE) | npm/GitHub release 6.4.299 published 2026-10-03; active releases through 2026. [npm](https://www.npmjs.com/package/pdfjs-dist), [release history](https://github.com/mozilla/pdf.js/releases) | Main 431,315 B (129,171 B gzip) + local worker 2,229,713 B (474,156 B gzip) | 0 / 0 in both | Grep found 3 XHR references in the main module and 1 in the worker, plus 4 and 40 `fetch(` calls respectively; these are library loading paths, not evidence of remote code import. The probe passes the selected file bytes as `Uint8Array`. PDF pages render to canvas with a DOM text layer for selection and ranges. [PDF.js examples](https://mozilla.github.io/pdf.js/examples/) |

The pattern scan searched the minified candidate output for `eval(` and `new Function`; it found no `eval(` occurrence in any candidate. The grep counts are an indicator for review, not a proof that every possible runtime path is network-free. The prototype's extension CSP and EPUB-frame CSP block network access, and its PDF.js call supplies bytes instead of a URL. Minified isolated bundles were kept in ignored `.cache/reader-eval/` and are not committed.

The prototype's complete emitted JS, including UI code and support chunks, is larger than any isolated candidate measurement: inspect `.cache/reader-extension/` after running the commands below. The independently measured chosen library/worker payload totals 2,838,032 B minified / 665,276 B gzip (Foliate parser entry + PDF.js main + PDF.js worker), before VOKA UI code and shared prototype chunks.

## Question 2 — EPUB security

The prototype uses Foliate's `makeBook(File)` parser and section/CFI data, then serializes each chapter into a dedicated `<iframe sandbox="allow-same-origin">` with no `allow-scripts`. Keeping same-origin access lets the parent inspect the chapter document and register highlights; omitting `allow-scripts` keeps book scripts disabled. The fixture deliberately retains an inline script element, and the probe confirmed that it did not run.

Before serialization, the prototype removes event-handler attributes, moves HTTP(S) resource attributes off active elements, strips external CSS `@import` and `url(...)` references, and applies a chapter CSP:

```text
default-src 'none'; script-src 'none'; connect-src 'none'; img-src data: blob:;
style-src 'unsafe-inline' blob:; font-src data: blob:; media-src 'none';
object-src 'none'; frame-src 'none'
```

The test EPUB has an image at `https://example.com/x.png`. The extension-page request log contained no request to that URL. The top-level MV3 prototype CSP is in `prototypes/reader/public/manifest.json`; it uses `script-src 'self'`, `connect-src 'none'`, `object-src 'none'`, and `worker-src 'self'`. Vite emits the PDF.js worker as a local `.mjs` asset. No remote script or module is loaded.

This is a conservative prototype, not a complete production EPUB sanitizer. A production integration must keep the sandbox/CSP restrictions, safely resolve packaged internal resources to Blob URLs, validate navigation links, bound archive size and decompression, and test adversarial EPUB/SVG/CSS inputs. Foliate itself documents that scripted EPUB content is unsupported because serving it from same-origin Blob URLs is unsafe; this prototype does not enable that feature. [Foliate security notes](https://github.com/johnfactotum/foliate-js#security)

## Question 3 — PDF.js

`reader.ts` imports `pdfjs-dist` plus `pdfjs-dist/build/pdf.worker.mjs?url`. The separate Vite config emits that worker into the extension package, and the prototype sets `pdfjs.GlobalWorkerOptions.workerSrc` to the emitted local URL. `getDocument` receives `new Uint8Array(await file.arrayBuffer())`, so opening a local PDF does not ask PDF.js to fetch a remote URL. Page 1 is rendered to a canvas; `page.getTextContent()` feeds `new pdfjs.TextLayer(...)`, which produces selectable DOM spans positioned against the same viewport.

The probe measured 231 non-whitespace text characters on page 1 of the generated text PDF and confirmed a local `chrome-extension://…/assets/pdf.worker-….mjs` worker. The image-only PDF yielded zero text characters on page 1, which triggers the requested message: **「此 PDF 没有可识别的文字层，暂不支持」**. This detects an absent text layer, not OCR quality; no OCR is performed.

For persistent PDF position, store page number plus an offset within that page (for example normalized scroll/viewport offset and text-item offset) so the value survives zoom changes. Restore the page first, then apply its normalized offset after rendering. The prototype only renders page 1; multi-page navigation and persistence are described below but not implemented here.

## Question 4 — Reusing highlighting and sentence logic

The vocabulary lookup and matching functions in `src/reading.ts` (`recognize`, `selectCandidate`) and the data lookup in `src/data/index.ts` are document-independent and can be reused. The current DOM traversal is not drop-in: `extract()` and `sentenceForRange()` use the ambient global `document`, `NodeFilter`, and style lookup, and the existing content-script lifecycle assumes the host page's single document.

Refactor DOM-facing helpers to accept the target `Document`/window (or derive it from `root.ownerDocument` / `range.startContainer.ownerDocument`). Use that document's `createTreeWalker`, `createRange`, `defaultView.getComputedStyle`, and `CSS.highlights`. For EPUB, tokenize the iframe document and register each range with that iframe document's own `CSS.highlights`; the test confirmed that registering only in the parent would not target the iframe. The prototype inserts the `::highlight(voka-important)` rule into the chapter document too. For PDF, the text layer is in the extension page, so ranges and `CSS.highlights` belong to the extension page document.

PDF text-layer spans can divide a word or sentence across multiple nodes. Production extraction should build a page-level normalized text stream with mappings back to DOM ranges (or PDF.js text items and transforms), then preserve source offsets for lookup, hit testing, and sentence context. Existing `Range.getClientRects()`-based hit testing can operate on mapped text-layer ranges. Sentence extraction should use the same document-aware walker and keep the offset-to-range mapping so a saved example still corresponds to source text. Keep dictionary lookup, CEFR matching, and gloss selection shared; add EPUB/PDF adapters around DOM traversal, position, and selection.

## Question 5 — Opening local files

Both file types are opened with `<input type="file">` on the `chrome-extension://` reader page. The selected `File` is passed directly to Foliate or converted to bytes for PDF.js. The unpacked MV3 prototype had no `file://` permission and no `file://` URL was opened. Puppeteer uploaded the three generated fixtures through the file input and verified the page protocol was `chrome-extension:`.

## Recommendation

For P2, start with Foliate's EPUB parser/CFI model plus a VOKA-owned, sandboxed iframe renderer. It is the smallest measured EPUB candidate, has no `eval`/`new Function` pattern in the tested bundle, and gave direct access to section documents and CFIs in this probe. Its full `<foliate-view>` is also available if VOKA wants its pagination and scrolling UI, but its closed shadow root makes VOKA's custom highlighting integration less direct; that path needs a separate integration spike. Do not choose epub.js while the measured release bundle includes a `new Function` construction under MV3's no-eval CSP. Readium is active and capable, but is a larger toolkit with publication-resource plumbing that was not validated for a local `File` in this experiment.

Use PDF.js for text PDFs, with its worker bundled locally and the selected file supplied as bytes. Keep the scan warning explicit and offer no OCR claim until an OCR path is separately evaluated.

## Position persistence design

Hash file bytes with SHA-256 using `crypto.subtle.digest`, then store only position metadata in `chrome.storage.local` under a key such as `reader-position:<sha256>`. Never key by the browser's file path. For EPUB, save the Foliate CFI (section/base CFI plus a range CFI) and restore after the chapter document and layout are ready by resolving the CFI and scrolling/navigating to its range. Re-resolve after font, viewport, or pagination changes. For PDF, save `{ pageNumber, normalizedPageOffset, textOffset? }`; render the page and text layer first, then restore the offset. Keep the hash-to-position record separate from reading data so different files cannot collide by name.

## Prototype results and known limits

`npx tsx prototypes/reader/check.ts` passed the automated file-picker, EPUB script block, remote image block, EPUB iframe highlight, PDF page/text layer/local worker, PDF highlight, and image-only warning checks in Chrome for Testing 156.0.8078.47. The fixture generator reported every fixture below 200 KB. The test confirmed no uncaught browser errors; expected blocked-script/CSP console messages were excluded from that error check.

Fixtures in `docs/research/epub-pdf-readers/fixtures/` contain only original synthetic sentences and generated artwork/text:

| File | Bytes | Purpose |
| --- | ---: | --- |
| `reader-fixture.epub` | 2,235 | EPUB 3 with two chapters, CEFR-like vocabulary, an inline script, and an external image URL |
| `text-fixture.pdf` | 1,154 | Text-backed PDF with the word “important” |
| `image-only-fixture.pdf` | 26,192 | Scanned-style PDF with text rendered into a single image and no PDF text layer |

Limits not covered by this probe:

- EPUB pagination/continuous scrolling UI, fixed-layout books, embedded internal images/fonts, navigation links, RTL/vertical text, audio/video, DRM, malformed/oversized archives, and full sanitizer adversarial testing.
- The reader renders one EPUB spine section at a time and only PDF page 1; EPUB/PDF position save/restore is a design recommendation, not an implemented feature.
- The scan detector checks whether page 1 has selectable characters; it does not OCR, assess garbled text, or determine whether later pages in a mixed document are scans.
- Readium was bundle-size and static-pattern scanned only; its local EPUB opening, security behavior, and reader UI were not run.
- No third-party book content was used; no Anki instance was contacted or changed.

## Re-run commands

From the repository root:

```sh
npm ci
npx tsx prototypes/reader/generate-fixtures.ts
npx tsx prototypes/reader/check.ts
npm run build && npm test
```

The `check.ts` command regenerates the fixtures, builds only the separate Vite config into ignored `.cache/reader-extension/`, launches Puppeteer's Chrome for Testing with a fresh temporary profile, loads the unpacked MV3 extension, logs PASS/FAIL per assertion, and removes the temporary profile. It does not modify the product manifest, product scripts, or `src/`.
