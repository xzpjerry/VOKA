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
