import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { build } from "vite";
import { generateFixtures } from "./generate-fixtures.ts";

declare global {
  interface Window {
    __vokaResearchGoToSecond?: () => Promise<unknown>;
    __vokaResearchState?: {
      kind: string | null;
      epubLoadedSections: number[];
      epubFixtureScriptPresent: boolean;
      epubScriptRan: boolean;
      epubRemoteImagePresent: boolean;
      epubHighlightRegistered: boolean;
      epubHighlightDocumentUrl: string | null;
      pdfPage: number | null;
      pdfTextChars: number;
      pdfHighlightRegistered: boolean;
      pdfWorkerSrc: string;
      scanned: boolean;
      error: string | null;
    };
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXTENSION = join(ROOT, ".cache/reader-extension");
const FIXTURES = join(ROOT, "docs/research/epub-pdf-readers/fixtures");
const TARGET_REMOTE_IMAGE = "https://example.com/x.png";

const failures: string[] = [];
function report(name: string, passed: boolean, detail = "") {
  const line = `${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  if (!passed) failures.push(line);
}

async function main() {
  await generateFixtures();
  await build({
    configFile: join(ROOT, "prototypes/reader/vite.config.ts"),
    logLevel: "error",
  });
  await mkdir(join(ROOT, ".cache"), { recursive: true });
  const profile = await mkdtemp(join(join(ROOT, ".cache"), "reader-chrome-"));
  let browser: puppeteer.Browser | undefined;
  try {
    browser = await puppeteer.launch({
      headless: true,
      userDataDir: profile,
      enableExtensions: [EXTENSION],
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run"],
    });
    const workerTarget = await browser.waitForTarget(
      (target) => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"),
      { timeout: 20_000 },
    );
    const extensionId = new URL(workerTarget.url()).host;
    const page = await browser.newPage();
    const requestedUrls: string[] = [];
    const pageErrors: string[] = [];
    page.on("request", (request) => requestedUrls.push(request.url()));
    page.on("requestfailed", (request) =>
      request.failure()?.errorText !== "csp"
        ? pageErrors.push(`requestfailed ${request.url()} ${request.failure()?.errorText}`)
        : undefined,
    );
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
    page.on("console", (message) => {
      if (message.type() === "error"
        && !message.text().includes("Blocked script execution")
        && !message.text().includes("violates the following Content Security Policy directive"))
        pageErrors.push(`${message.type()}: ${message.text()}`);
    });
    await page.goto(`chrome-extension://${extensionId}/reader.html`);

    const inputAvailable = await page.$eval(
      "#file-input",
      (input) => input instanceof HTMLInputElement && input.type === "file",
    );
    report(
      "a. File chooser opens inside the unpacked MV3 extension page",
      page.url().startsWith("chrome-extension://") && inputAvailable,
      `page=${new URL(page.url()).protocol}, input[type=file]=${inputAvailable}; no file:// permission used`,
    );

    await page.$eval<HTMLInputElement>("#file-input", (input) => input.value = "");
    await (await page.$("#file-input"))!.uploadFile(join(FIXTURES, "reader-fixture.epub"));
    try {
      await page.waitForFunction(
        () => window.__vokaResearchState?.epubLoadedSections.includes(0),
        { timeout: 20_000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        status: document.querySelector("#status")?.textContent,
        state: window.__vokaResearchState,
        frames: window.frames.length,
        frameUrls: Array.from(document.querySelectorAll("iframe")).map((frame) => frame.src),
      }));
      console.error("EPUB diagnostic", diagnostics, pageErrors, requestedUrls, page.frames().map((frame) => frame.url()));
      throw error;
    }
    await page.evaluate(async () => await window.__vokaResearchGoToSecond?.());
    try {
      await page.waitForFunction(
        () => window.__vokaResearchState?.epubLoadedSections.includes(1) && window.__vokaResearchState.epubRemoteImagePresent,
        { timeout: 20_000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        status: document.querySelector("#status")?.textContent,
        state: window.__vokaResearchState,
        images: Array.from(document.querySelectorAll("iframe")).flatMap((frame) => {
          try {
            return Array.from(frame.contentDocument?.querySelectorAll("img") ?? []).map((image) => image.outerHTML);
          } catch {
            return ["cross-origin iframe"];
          }
        }),
      }));
      console.error("EPUB chapter-2 diagnostic", diagnostics, pageErrors, requestedUrls);
      throw error;
    }
    const epubState = await page.evaluate(() => ({ ...window.__vokaResearchState }));
    const remoteImageRequested = requestedUrls.includes(TARGET_REMOTE_IMAGE);
    report(
      "b. EPUB script stays disabled and its remote image is blocked",
      epubState.epubFixtureScriptPresent && !epubState.epubScriptRan && epubState.epubRemoteImagePresent && !remoteImageRequested,
      `script tag present=${epubState.epubFixtureScriptPresent}, script ran=${epubState.epubScriptRan}, remote image requested=${remoteImageRequested}`,
    );
    report(
      "d. EPUB Custom Highlight is registered in the EPUB iframe document",
      epubState.epubHighlightRegistered && !!epubState.epubHighlightDocumentUrl,
      `CSS.highlights set for “important” in ${epubState.epubHighlightDocumentUrl ?? "no chapter document"}`,
    );

    await (await page.$("#file-input"))!.uploadFile(join(FIXTURES, "text-fixture.pdf"));
    await page.waitForFunction(
      () => window.__vokaResearchState?.kind === "pdf" && window.__vokaResearchState.pdfPage === 1 && window.__vokaResearchState.pdfTextChars > 0,
      { timeout: 20_000 },
    );
    const pdfState = await page.evaluate(() => ({ ...window.__vokaResearchState }));
    const hasPdfTextLayer = await page.$eval("#pdf-page .textLayer", (element) =>
      (element.textContent ?? "").includes("important"),
    ).catch(() => false);
    const localWorker = pdfState.pdfWorkerSrc.startsWith(`chrome-extension://${extensionId}/`)
      && /.mjs(?:$|\?)/.test(pdfState.pdfWorkerSrc);
    report(
      "c. PDF.js renders page 1 with a text layer and a bundled local worker",
      pdfState.pdfPage === 1 && hasPdfTextLayer && localWorker,
      `page=${pdfState.pdfPage}, text characters=${pdfState.pdfTextChars}, worker=${pdfState.pdfWorkerSrc}`,
    );
    report(
      "d. PDF.js text layer highlights “important” with CSS Custom Highlight",
      pdfState.pdfHighlightRegistered && hasPdfTextLayer,
      `CSS.highlights registered=${pdfState.pdfHighlightRegistered}`,
    );

    await (await page.$("#file-input"))!.uploadFile(join(FIXTURES, "image-only-fixture.pdf"));
    await page.waitForFunction(
      () => window.__vokaResearchState?.scanned === true,
      { timeout: 20_000 },
    );
    const scanMessage = await page.$eval("#status", (element) => element.textContent);
    report(
      "e. Image-only PDF is identified and shows the unsupported scan message",
      scanMessage === "此 PDF 没有可识别的文字层，暂不支持",
      `status=${scanMessage}`,
    );

    if (pageErrors.length) {
      report("Reader page has no uncaught browser errors", false, pageErrors.join(" | "));
    } else {
      report("Reader page has no uncaught browser errors", true);
    }
    assert.equal(failures.length, 0, failures.join("\n"));
  } finally {
    await browser?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error("FAIL reader prototype run", error);
  process.exitCode = 1;
});
