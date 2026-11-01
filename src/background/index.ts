import { LEVELS, loadData } from "../data";
import { selectCandidate } from "../reading";
import { normalizeKey } from "../key";
import { cardContext } from "./contexts";
import { previewUpgrade, executeUpgrade, type UpgradePreview } from "./upgrade";
import { updateGlossCss } from "./gloss";
import { pageStates } from "./reading";
import { previewImport, executeImport, importTarget } from "./import";
import { checkConnection, rpc, GatewayError } from "./gateway";
import { settings } from "../shared";
import { scheduleSiteSync, shouldAutoRun } from "./sites";
import {
  prepareAnswer,
  renderCard,
  reviewRatings,
  submitReview,
} from "./review";
const upgradePreviews = new Map<string, { preview: UpgradePreview; created: number }>();
let upgradeBusy = false;
let importBusy = false;
let importController: AbortController | undefined;
let contextQueue = Promise.resolve();
async function notifyDisconnected() {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id)
      void chrome.tabs
        .sendMessage(tab.id, { type: "connection-lost" })
        .catch(() => {});
  }
}
const gatewayCall: typeof rpc = async (...args) => {
  try {
    return await rpc(...args);
  } catch (error) {
    if (error instanceof GatewayError && error.status === "unreachable")
      void notifyDisconnected();
    throw error;
  }
};
async function checked(config: Parameters<typeof checkConnection>[0]) {
  const status = await checkConnection(config);
  if (status !== "ok") void notifyDisconnected();
  return status;
}
const reviewCardId = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value);
function isYouTubeWatchPage(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.hostname === "www.youtube.com" &&
      (url.pathname === "/watch" || url.pathname.startsWith("/shorts/"))
    );
  } catch {
    return false;
  }
}
function isContextSourceLabel(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const label = value as { site?: unknown; title?: unknown };
  return (
    typeof label.site === "string" &&
    label.site.length > 0 &&
    label.site.length <= 200 &&
    typeof label.title === "string" &&
    label.title.length > 0 &&
    label.title.length <= 200
  );
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (
    message?.type === "youtube-main-inject" &&
    sender.tab?.id !== undefined &&
    sender.url
  ) {
    let allowedPage = false;
    try {
      const pageUrl = new URL(sender.url);
      allowedPage =
        pageUrl.hostname === "www.youtube.com" &&
        (pageUrl.pathname === "/watch" || pageUrl.pathname.startsWith("/shorts/"));
    } catch {
      allowedPage = false;
    }
    if (!allowedPage) {
      reply({ error: "unsupported YouTube page" });
      return;
    }
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id },
        files: ["youtube-main.js"],
        world: "MAIN",
      })
      .then(
        () => reply({ ok: true }),
        () => reply({ error: "main world injection failed" }),
      );
  } else if (
    message?.type === "request-access" &&
    sender.url?.split("?")[0] === chrome.runtime.getURL("options.html")
  ) {
    settings()
      .then((config) =>
        rpc(config, "access.requestPermission", {}, { timeoutMs: 120000 }),
      )
      .then(
        (data) => reply({ data }),
        (error) => reply({ error: String(error) }),
      );
  } else if (message?.type === "check-connection") {
    settings()
      .then(checked)
      .then(reply, () => reply("unreachable"));
  } else if (
    message?.type === "should-auto-run" &&
    sender.tab &&
    /^https?:/i.test(sender.url || "")
  ) {
    shouldAutoRun(sender.url).then(
      (run) => reply({ run }),
      () => reply({ run: false }),
    );
  } else if (
    message?.type === "sync-site-scope" &&
    sender.url?.split("?")[0] === chrome.runtime.getURL("options.html")
  ) {
    scheduleSiteSync().then(
      () => reply({ ok: true }),
      (error) => reply({ error: String(error) }),
    );
  } else if (
    message?.type === "recognize-words" &&
    Array.isArray(message.words) &&
    message.words.length <= 10000 &&
    message.words.every(
      (word: unknown) =>
        typeof word === "string" &&
        word.length <= 200 &&
        /^[\p{L}\p{M}'’-]+$/u.test(word),
    )
  ) {
    (async () => {
      const config = await settings();
      if ((await checked(config)) !== "ok") throw new Error("unreachable");
      const data = await loadData();
      return Object.fromEntries(
        message.words.map((word: string) => {
          const candidates = data.lemmaCandidates(word).map(data.lookupEntry);
          const match = selectCandidate(word, candidates) ?? {
            key: normalizeKey(data.lookupEntry(word).lemma),
            entry: data.lookupEntry(word),
          };
          return [word, { ...match, candidates }];
        }),
      );
    })().then(
      (data) => reply({ data }),
      (error) => reply({ error: String(error) }),
    );
  } else if (
    message?.type === "card-context" &&
    sender.tab &&
    ((/^https?:/.test(sender.url || "")) ||
      (sender.url === chrome.runtime.getURL("reader.html") &&
        isContextSourceLabel(message.sourceLabel))) &&
    typeof message.key === "string" &&
    /^en:[\p{L}\p{M}'-]+$/u.test(message.key) &&
    ["read", "save", "pin", "manual"].includes(message.action)
  ) {
    contextQueue = contextQueue
      .catch(() => {})
      .then(async () => {
        try {
          const config = await settings();
          if ((await checked(config)) !== "ok") throw new Error("unreachable");
          const data = await cardContext(
            (method, params = {}, write = false) =>
              gatewayCall(config, method, params, { sideEffecting: write }),
            {
              ...message,
              url: sender.url,
              sourceLabel:
                sender.url === chrome.runtime.getURL("reader.html") ||
                (isYouTubeWatchPage(sender.url) &&
                  isContextSourceLabel(message.sourceLabel))
                  ? message.sourceLabel
                  : undefined,
            },
            config,
          );
          reply({ data });
        } catch (error) {
          reply({ error: String(error) });
        }
      });
  } else if (
    ["review-render", "review-prepare", "review-submit"].includes(
      message?.type,
    )
  ) {
    const cardId = message.cardId;
    const validSubmission =
      message.type !== "review-submit" ||
      ((reviewRatings as readonly unknown[]).includes(message.rating) &&
        typeof message.stateToken === "string" &&
        message.stateToken.length > 0 &&
        typeof message.elapsedMs === "number" &&
        Number.isFinite(message.elapsedMs) &&
        message.elapsedMs >= 0 &&
        (typeof message.latestReviewId === "string" ||
          typeof message.latestReviewId === "number" ||
          message.latestReviewId === null));
    if (!reviewCardId(cardId) || !validSubmission) {
      reply({ error: "invalid review request" });
      return;
    }
    (async () => {
      const config = await settings();
      if ((await checked(config)) !== "ok") throw new Error("unreachable");
      const call = async (method: string, params = {}) => {
        try {
          return await gatewayCall(config, method, params, {
            sideEffecting: method === "scheduling.answer",
          });
        } catch (error) {
          const code =
            error instanceof GatewayError
              ? error.code
              : typeof error === "object" && error !== null && "code" in error
                ? (error as { code?: number }).code
                : undefined;
          if (
            method === "scheduling.answer" &&
            code !== 1008 &&
            sender.tab?.id
          )
            void chrome.tabs
              .sendMessage(sender.tab.id, {
                type: "review-confirming",
                cardId,
              })
              .catch(() => {});
          throw error;
        }
      };
      if (message.type === "review-render") return renderCard(call, cardId);
      if (message.type === "review-prepare")
        return prepareAnswer(call, cardId);
      return submitReview(call, {
        cardId,
        rating: message.rating,
        stateToken: message.stateToken,
        elapsedMs: message.elapsedMs,
        latestReviewId: message.latestReviewId,
      });
    })().then(
      (data) => reply({ data }),
      (error) => reply({ error: String(error) }),
    );
  } else if (
    message?.type === "page-states" &&
    Array.isArray(message.keys) &&
    message.keys.length <= 10000 &&
    message.keys.every(
      (k: unknown) => typeof k === "string" && /^en:[\p{L}\p{M}'.-]+$/u.test(k),
    )
  ) {
    (async () => {
      const config = await settings();
      const status = await checked(config);
      if (status !== "ok") throw new Error(status);
      return pageStates(
        (method, params = {}) => gatewayCall(config, method, params),
        message.keys,
      );
    })().then(
      (data) => reply({ data }),
      () => reply({ error: "unreachable" }),
    );
  } else if (message?.type === "open-gloss-upgrade") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("options.html?upgrade=1") });
    reply({ ok: true });
  } else if (
    message?.type === "upgrade-summary" ||
    (["preview-upgrade", "execute-upgrade"].includes(message?.type) &&
      sender.url?.split("?")[0] === chrome.runtime.getURL("options.html"))
  ) {
    if (message.type !== "upgrade-summary" && (upgradeBusy || importBusy)) { reply({ error: "正在处理，请稍后再试" }); return; }
    if (message.type !== "upgrade-summary") upgradeBusy = true;
    const work = async () => {
      const config = await settings();
      if ((await checked(config)) !== "ok") throw new Error("unreachable");
      const call = (method: string, params = {}, write = false) =>
        gatewayCall(config, method, params, { sideEffecting: write });
      if (message.type === "execute-upgrade") {
        const stored = upgradePreviews.get(message.token);
        if (!stored || Date.now() - stored.created > 30 * 60 * 1000 || !Array.isArray(message.selected) || !message.selected.every((id: unknown) => typeof id === "string"))
          throw new Error("预览已过期，请重新检查");
        upgradePreviews.delete(message.token);
        return executeUpgrade(call, stored.preview, message.selected, data => {
          void chrome.runtime.sendMessage({ type: "upgrade-progress", data }).catch(() => {});
        });
      }
      const preview = await previewUpgrade(call, config.nativeLanguage);
      if (message.type === "upgrade-summary") return { count: preview.rows.length };
      for (const [key, value] of upgradePreviews)
        if (Date.now() - value.created > 30 * 60 * 1000) upgradePreviews.delete(key);
      if (upgradePreviews.size >= 10) upgradePreviews.delete(upgradePreviews.keys().next().value!);
      const token = crypto.randomUUID();
      upgradePreviews.set(token, { preview, created: Date.now() });
      return { ...preview, token };
    };
    // Context saves and upgrades share VokaMeta; serialize their fresh-read/merge/write.
    contextQueue = contextQueue.catch(() => {}).then(async () => {
      try { reply({ data: await work() }); } catch (error) { reply({ error: String(error) }); }
      finally { if (message.type !== "upgrade-summary") upgradeBusy = false; }
    });
  } else if (
    ["preview-import", "execute-import", "cancel-import"].includes(
      message?.type,
    ) &&
    sender.url?.split("?")[0] === chrome.runtime.getURL("options.html")
  ) {
    if (message.type === "cancel-import") {
      importController?.abort();
      reply({ data: { cancelling: !!importController } });
      return true;
    }
    if (importBusy || upgradeBusy) {
      reply({ error: "导入正在进行，请等待完成。" });
      return;
    }
    importBusy = true;
    const controller =
      message.type === "execute-import" ? new AbortController() : undefined;
    if (controller) importController = controller;
    (async () => {
      const config = await settings();
      const status = await checked(config);
      if (status !== "ok") throw new Error(status);
      const call = (method: string, params = {}, write = false) =>
        gatewayCall(config, method, params, { sideEffecting: write });
      const level = LEVELS.includes(message.level)
        ? message.level
        : config.targetLevel;
      const target = importTarget(level, config.testImportTarget);
      if (message.type === "preview-import")
        return previewImport(call, target);
      return executeImport(
        call,
        target,
        config.glossLanguage,
        config.nativeLanguage,
        undefined,
        {
          signal: controller!.signal,
          onProgress: (data) => {
            void chrome.runtime
              .sendMessage({ type: "import-progress", data })
              .catch(() => {});
          },
        },
      );
    })()
      .then(
        (data) => reply({ data }),
        (error) => reply({ error: String(error) }),
      )
      .finally(() => {
        importBusy = false;
        if (importController === controller) importController = undefined;
      });
  } else return;
  return true;
});
// Serialize changes so quick successive selections cannot finish out of order.
let glossUpdate = Promise.resolve();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    changes.siteScope ||
    changes.denyList ||
    changes.rememberedSites
  )
    void scheduleSiteSync();
  if (!(changes.glossLanguage || changes.nativeLanguage)) return;
  glossUpdate = glossUpdate
    .catch(() => {})
    .then(async () => {
      const config = await settings();
      if ((await checked(config)) !== "ok") return;
      await updateGlossCss(
        (method, params = {}, write = false) =>
          gatewayCall(config, method, params, { sideEffecting: write }),
        config.nativeLanguage === "en" ? "target" : config.glossLanguage,
      );
    })
    .catch((error) =>
      console.error("VOKA gloss CSS update failed; setting retained", error),
    );
});

chrome.permissions.onAdded.addListener(() => void scheduleSiteSync());
chrome.permissions.onRemoved.addListener(() => void scheduleSiteSync());
chrome.runtime.onStartup.addListener(() => void scheduleSiteSync());
void scheduleSiteSync();

chrome.runtime.onInstalled.addListener(({ reason }) => {
  void scheduleSiteSync();
  if (reason === "install")
    void chrome.tabs.create({
      url: chrome.runtime.getURL("options.html?wizard=1"),
    });
});
