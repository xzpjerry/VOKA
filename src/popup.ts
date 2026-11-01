import { forgetSite, rememberSite, scheduleSiteSync, shouldAutoRun } from "./background/sites";
import { hostMatchesDeny, httpHost } from "./site-scope";
import { settings, t } from "./shared";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const toggle = element<HTMLInputElement>("auto");
const pause = element<HTMLButtonElement>("pause");
const remove = element<HTMLButtonElement>("removeDeny");
const feedback = element("feedback");
let tab: chrome.tabs.Tab | undefined;
let host: string | undefined;
let supported = false;
let busy = false;
element("pause").textContent = t("popupPause");
element("options").textContent = t("popupOptions");
remove.textContent = t("popupRemoveDeny");
element("options").onclick = () => void chrome.runtime.openOptionsPage();

async function render() {
  const config = await settings();
  const denied = !!host && hostMatchesDeny(host, config.denyList);
  element("host").textContent = host ?? "VOKA";
  element("autoLabel").textContent = t("popupAuto").replace("{host}", host ?? "—");
  toggle.checked = supported && await shouldAutoRun(tab?.url);
  toggle.disabled = busy || !supported || denied;
  pause.disabled = busy || !supported;
  element("status").textContent = t(!supported ? "popupUnsupported" : denied ? "popupDenied" : toggle.checked ? "popupAutomatic" : "popupManual");
  element("blocked").hidden = !denied;
  element("blocked").textContent = t("popupBlocked");
  remove.hidden = !denied;
  remove.disabled = busy;
}

// rememberSite calls permissions.request before its first await. Keep this
// call directly in the extension page's trusted click, never in a worker.
toggle.onclick = () => {
  if (!host || busy) return;
  const pending = toggle.checked ? rememberSite(host) : forgetSite(host).then(() => true);
  busy = true;
  toggle.disabled = true;
  void pending.then(ok => { feedback.textContent = t(ok ? "popupSaved" : "popupPermissionDenied"); })
    .catch(() => { feedback.textContent = t("popupFailed"); })
    .finally(() => { busy = false; void render(); });
};
remove.onclick = () => {
  if (!host || busy) return;
  busy = true;
  void settings().then(config => chrome.storage.local.set({
    denyList: config.denyList.filter(entry => !hostMatchesDeny(host!, [entry])),
  })).then(scheduleSiteSync).catch(() => { feedback.textContent = t("popupFailed"); })
    .finally(() => { busy = false; void render(); });
};
pause.onclick = () => {
  if (tab?.id === undefined) return;
  void chrome.tabs.sendMessage(tab.id, { type: "pause-reading" })
    .then(() => { feedback.textContent = t("popupPaused"); })
    .catch(() => { feedback.textContent = t("popupFailed"); });
};

void (async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  host = httpHost(tab?.url);
  if (host && tab?.id !== undefined) {
    try {
      // Opening action.default_popup grants activeTab. Manual injection bypasses
      // the auto-run deny list and never requests optional host permission.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      supported = true;
    } catch { /* Protected pages (including the web store) cannot be injected. */ }
  }
  await render();
})().catch(() => { element("status").textContent = t("popupFailed"); });
