import { settings, check, t } from "./shared";
const style = document.createElement("style");
style.textContent =
  "body{font:16px system-ui;color:#17212b;background:#f5f7fa}main{max-width:520px;margin:64px auto;padding:32px;background:white;border-radius:16px}label{display:grid;gap:8px;margin:20px 0}input,button,select{font:inherit;padding:10px}[hidden]{display:none!important}";
document.head.append(style);
document.documentElement.lang = chrome.i18n.getUILanguage();
document
  .querySelectorAll<HTMLElement>("[data-i18n]")
  .forEach((el) => (el.textContent = t(el.dataset.i18n!)));
const port = document.querySelector<HTMLInputElement>("#port")!;
const apiKey = document.querySelector<HTMLInputElement>("#apiKey")!;
const status = document.querySelector<HTMLElement>("#status")!;
const button = document.querySelector<HTMLButtonElement>("button")!;
const initial = await settings();
port.value = String(initial.port);
apiKey.value = initial.apiKey;
async function refresh() {
  button.disabled = true;
  status.textContent = t("checking");
  try {
    status.textContent = t(`status_${(await check()).replaceAll("-", "_")}`);
  } catch {
    status.textContent = t("status_unreachable");
  } finally {
    button.disabled = false;
  }
}
document.querySelector("form")!.addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set({
    port: Number(port.value),
    apiKey: apiKey.value.trim(),
  });
  await refresh();
});
await refresh();
const previewButton = document.querySelector<HTMLButtonElement>("#preview")!;
const confirmButton = document.querySelector<HTMLButtonElement>("#confirm")!;
const importStatus = document.querySelector<HTMLElement>("#importStatus")!;
async function showPreview() {
  confirmButton.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: "preview-import" });
  if (result.error) throw new Error(result.error);
  const p = result.data;
  importStatus.textContent = `${t("importDeck")}: ${p.target.deck} · ${t(p.deckExists ? "importExists" : "importNew")}\n${t("importType")}: ${p.target.noteType} · ${t(p.typeExists ? "importExists" : "importNew")}\n${t("importNew")} ${p.counts.new} / ${t("importExists")} ${p.counts.existing} / ${t("importConflict")} ${p.counts.conflict} / ${t("importSkipped")} ${p.counts.skipped}\n${p.rows
    .filter((r: { state: string }) => r.state === "conflict")
    .map((r: { key: string }) => r.key)
    .join("\n")}\n${p.source}\n${p.license} · ${p.version}`;
  confirmButton.disabled = p.counts.new === 0;
}
previewButton.addEventListener("click", async () => {
  previewButton.disabled = true;
  try {
    await showPreview();
  } catch (error) {
    importStatus.textContent = String(error);
  } finally {
    previewButton.disabled = false;
  }
});
confirmButton.addEventListener("click", async () => {
  confirmButton.disabled = true;
  previewButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "execute-import" });
    if (result.error) throw new Error(result.error);
    await showPreview();
    importStatus.textContent += `\n${t("importConfirmed")}: ${result.data.confirmed.length}\n${result.data.failures.map((f: { key: string; reason: string }) => `${f.key}: ${f.reason}`).join("\n")}`;
  } catch (error) {
    confirmButton.disabled = true;
    importStatus.textContent = String(error);
  } finally {
    previewButton.disabled = false;
  }
});
// Changing connection settings invalidates the preview and its confirmation.
for (const input of [port, apiKey])
  input.addEventListener("input", () => {
    confirmButton.disabled = true;
    importStatus.textContent = "";
  });

const nativeLanguage =
  document.querySelector<HTMLSelectElement>("#nativeLanguage")!;
const glossLanguage =
  document.querySelector<HTMLSelectElement>("#glossLanguage")!;
const glossRow = document.querySelector<HTMLElement>("#glossLanguageRow")!;
nativeLanguage.value = initial.nativeLanguage;
glossLanguage.value = initial.glossLanguage;
const showGloss = () => {
  glossRow.hidden = nativeLanguage.value === "en";
};
showGloss();
for (const select of [nativeLanguage, glossLanguage])
  select.addEventListener("change", async () => {
    showGloss();
    await chrome.storage.local.set({
      nativeLanguage: nativeLanguage.value,
      glossLanguage: glossLanguage.value,
    });
  });
// Render source metadata and complete upstream notices without interpreting data as HTML.
async function showAttributions() {
  const section = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = t("aboutTitle");
  section.append(heading);
  document.querySelector("main")!.append(section);
  try {
    const response = await fetch(
      chrome.runtime.getURL("data/attributions.json"),
    );
    if (!response.ok) throw new Error(String(response.status));
    const metadata = await response.json();
    for (const pack of metadata.packs) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${pack.source[0].split("/").pop()} · ${pack.license} · ${pack.version}`;
      const text = document.createElement("p");
      text.textContent = `${pack.attribution} ${pack.dataVersion} · ${pack.generatedDate} · ${pack.entryCount}`;
      const link = document.createElement("a");
      link.href = pack.licenseUrl;
      link.textContent = pack.license;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      details.append(summary, text, link);
      section.append(details);
    }
    for (const [name, notice] of Object.entries(metadata.notices)) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = name;
      const text = document.createElement("pre");
      text.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere";
      text.textContent = String(notice);
      details.append(summary, text);
      section.append(details);
    }
  } catch {
    const error = document.createElement("p");
    error.textContent = t("dataLoadError");
    section.append(error);
  }
}
void showAttributions();
