import { rememberSite } from "./background/sites";
import { normalizeHostEntry } from "./site-scope";
import { settings, t } from "./shared";

const host = new URL(location.href).searchParams.get("host");
const button = document.querySelector<HTMLButtonElement>("#remember")!;
const status = document.querySelector<HTMLElement>("#status")!;
button.textContent = t("rememberSiteButton");
document.querySelector("#description")!.textContent =
  t("rememberSiteDescription").replace("{host}", host ?? "");
const close = document.querySelector<HTMLButtonElement>("#close")!;
close.textContent = t("rememberSiteClose");
close.onclick = () => window.close();
// Only this extension-origin button requests permission, directly in its own
// gesture. No messages from a web page can trigger a permission request.
button.onclick = () => {
  if (!host || button.disabled) return;
  const pending = rememberSite(host);
  button.disabled = true;
  void pending.then((granted) => {
    status.textContent = t(granted ? "rememberSiteSaved" : "rememberSiteDenied");
    button.disabled = granted;
  }).catch(() => {
    status.textContent = t("rememberSiteDenied");
    button.disabled = false;
  });
};
void settings().then((config) => {
  button.disabled = !host || normalizeHostEntry(host) !== host || config.siteScope !== "remembered";
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.siteScope)
    button.disabled = changes.siteScope.newValue !== "remembered" || !host || normalizeHostEntry(host) !== host;
});
