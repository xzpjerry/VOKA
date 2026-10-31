import { settings, check, t } from "./shared";
const style = document.createElement("style");
style.textContent =
  "body{font:16px system-ui;color:#17212b;background:#f5f7fa}main{max-width:520px;margin:64px auto;padding:32px;background:white;border-radius:16px}label{display:grid;gap:8px;margin:20px 0}input,button{font:inherit;padding:10px}";
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
