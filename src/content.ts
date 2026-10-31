import { check, t } from "./shared";
(() => {
  if (document.getElementById("voka-drawer")) return;
  const host = document.createElement("div");
  host.id = "voka-drawer";
  host.style.cssText =
    "all:initial;position:fixed;bottom:0;right:16px;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent =
    ":host{color-scheme:light}section{font:14px system-ui,sans-serif;background:#fff;color:#17212b;border:1px solid #ccd3dc;border-radius:12px 12px 0 0;padding:12px 16px;box-shadow:0 2px 16px #0002;display:flex;gap:16px;align-items:center}button{font:inherit;padding:5px 12px;cursor:pointer}";
  const drawer = document.createElement("section");
  drawer.setAttribute("aria-label", "VOKA");
  const summary = document.createElement("span");
  summary.setAttribute("role", "status");
  const retry = document.createElement("button");
  retry.textContent = t("retry");
  async function refresh() {
    retry.disabled = true;
    summary.textContent = t("checking");
    let status;
    try {
      status = await check();
    } catch {
      status = "unreachable";
    }
    summary.textContent = t(status === "ok" ? "connected" : "notRunning");
    retry.hidden = status === "ok";
    retry.disabled = false;
  }
  retry.addEventListener("click", refresh);
  drawer.append(summary, retry);
  root.append(style, drawer);
  document.documentElement.append(host);
  void refresh();
})();
