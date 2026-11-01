import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import puppeteer from "puppeteer";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = join(ROOT, "docs/research/epub-pdf-readers/fixtures");

const chapter = (title: string, paragraphs: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head><title>${title}</title><meta charset="UTF-8" /></head>
  <body><h1>${title}</h1>${paragraphs.map((line) => `<p>${line}</p>`).join("\n")}</body>
</html>`;

function makeEpub() {
  const chapterOne = chapter("A Helpful Garden", [
    "An important plan can improve a small garden.",
    "When people share a clear goal, they can achieve more together.",
    "The community uses careful steps to protect its water.",
    "Each simple idea can help a neighbor solve a problem.",
  ]);
  const chapterTwo = chapter("Working Together", [
    "It is important to keep the path clean and safe.",
    "Friends prepare a meal and discuss their decision.",
    "They separate the tools, then improve the next plan.",
  ]).replace(
    "</body>",
    '<script>window.__vokaResearchFixtureScriptRan = true;</script></body>',
  ).replace(
    "<h1>Working Together</h1>",
    '<h1>Working Together</h1><img src="https://example.com/x.png" alt="Remote resource probe" />',
  );

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles>
</container>`;
  const packageDoc = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:voka:research:reader-fixture</dc:identifier>
    <dc:title>VOKA Reader Research Fixture</dc:title><dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-11-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="chapter-one" href="chapter-one.xhtml" media-type="application/xhtml+xml" />
    <item id="chapter-two" href="chapter-two.xhtml" media-type="application/xhtml+xml" properties="scripted" />
  </manifest>
  <spine><itemref idref="chapter-one" /><itemref idref="chapter-two" /></spine>
</package>`;
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol>
    <li><a href="chapter-one.xhtml">A Helpful Garden</a></li><li><a href="chapter-two.xhtml">Working Together</a></li>
  </ol></nav></body>
</html>`;
  return zipSync(
    {
      mimetype: [strToU8("application/epub+zip"), { level: 0 }],
      "META-INF/container.xml": strToU8(container),
      "OEBPS/content.opf": strToU8(packageDoc),
      "OEBPS/nav.xhtml": strToU8(nav),
      "OEBPS/chapter-one.xhtml": strToU8(chapterOne),
      "OEBPS/chapter-two.xhtml": strToU8(chapterTwo),
    },
    { level: 6 },
  );
}

async function makeTextPdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("A Helpful Garden", {
    x: 60,
    y: 710,
    size: 24,
    font,
    color: rgb(0.1, 0.2, 0.35),
  });
  const lines = [
    "An important plan can improve a small garden.",
    "When people share a clear goal, they can achieve more together.",
    "The community uses careful steps to protect its water.",
    "Each simple idea can help a neighbor solve a problem.",
  ];
  lines.forEach((line, index) =>
    page.drawText(line, { x: 60, y: 660 - index * 36, size: 15, font }),
  );
  return pdf.save();
}

async function makeScannedPdf() {
  await mkdir(resolve(ROOT, ".cache"), { recursive: true });
  const profile = await mkdtemp(join(resolve(ROOT, ".cache"), "fixture-chrome-"));
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: profile,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1165, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0;width:900px;height:1165px;background:white;display:grid;place-items:center;font:36px Arial,sans-serif;color:#222"><main><h1>Scanned garden note</h1><p>An important plan can improve a small garden.</p><p>This page is only a picture.</p></main></body></html>`);
    const image = await page.screenshot({ type: "png", fullPage: true });
    const pdf = await PDFDocument.create();
    const pdfPage = pdf.addPage([612, 792]);
    const embedded = await pdf.embedPng(image);
    pdfPage.drawImage(embedded, { x: 24, y: 24, width: 564, height: 744 });
    return pdf.save();
  } finally {
    await browser.close();
    await rm(profile, { recursive: true, force: true });
  }
}

export async function generateFixtures() {
  await mkdir(FIXTURES, { recursive: true });
  const outputs = [
    ["reader-fixture.epub", makeEpub()],
    ["text-fixture.pdf", await makeTextPdf()],
    ["image-only-fixture.pdf", await makeScannedPdf()],
  ] as const;
  for (const [name, data] of outputs) {
    const path = join(FIXTURES, name);
    await writeFile(path, data);
    const { size } = await stat(path);
    if (size >= 200 * 1024)
      throw new Error(`${name} is ${size} bytes; fixtures must remain under 200 KB`);
    console.log(`${name}: ${size} bytes`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await generateFixtures();
