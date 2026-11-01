import { createReadingSession } from "./reading-session";
import { createYouTubeController } from "./youtube/controller";

declare const __VOKA_AUTO_RUN__: boolean;

type YouTubeWindow = Window & {
  __VOKA_YOUTUBE_CONTROLLER__?: ReturnType<typeof createYouTubeController>;
};

function isYouTubeWatchOrShorts() {
  return (
    location.hostname === "www.youtube.com" &&
    (location.pathname === "/watch" || location.pathname.startsWith("/shorts/"))
  );
}

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
  if (isYouTubeWatchOrShorts()) {
    const pageWindow = window as YouTubeWindow;
    if (pageWindow.__VOKA_YOUTUBE_CONTROLLER__) {
      void pageWindow.__VOKA_YOUTUBE_CONTROLLER__.start();
      return;
    }
    const controller = createYouTubeController({
      uiDocument: document,
      createSession: () =>
        createReadingSession({ uiDocument: document, sources: [] }),
    });
    pageWindow.__VOKA_YOUTUBE_CONTROLLER__ = controller;
    window.addEventListener(
      "unload",
      () => {
        controller.stop();
        delete pageWindow.__VOKA_YOUTUBE_CONTROLLER__;
      },
      { once: true },
    );
    void controller.start();
    return;
  }
  const session = createReadingSession({
    uiDocument: document,
    sources: [{ kind: "dom", root: document.body }],
  });
  document.addEventListener("voka-refresh", () => void session.refresh());
  void session.start();
})();
