import { createReadingSession } from "./reading-session";

declare const __VOKA_AUTO_RUN__: boolean;

async function autoRunAllowed(): Promise<boolean> {
  if (!__VOKA_AUTO_RUN__) return true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "should-auto-run",
      url: location.href,
    });
    return response?.run === true;
  } catch {
    return false;
  }
}

void (async () => {
  if (__VOKA_AUTO_RUN__ && !(await autoRunAllowed())) return;
  if (document.getElementById("voka-drawer")) {
    document.dispatchEvent(new Event("voka-refresh"));
    return;
  }
  const session = createReadingSession({
    uiDocument: document,
    sources: [{ kind: "dom", root: document.body }],
  });
  document.addEventListener("voka-refresh", () => void session.refresh());
  void session.start();
})();
