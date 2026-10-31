import { loadData } from "../data";
import { normalizeKey } from "../key";
import { updateGlossCss } from "./gloss";
import { pageStates } from "./reading";
import { previewImport, executeImport } from "./import";
import { checkConnection, rpc, GatewayError } from "./gateway";
import { settings } from "../shared";
let importBusy = false;
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
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "check-connection") {
    settings()
      .then(checked)
      .then(reply, () => reply("unreachable"));
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
          const lemma = data.lemmaCandidates(word)[0] ?? word;
          const entry = data.lookupEntry(lemma);
          return [word, { key: normalizeKey(entry.lemma), entry }];
        }),
      );
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
  } else if (
    ["preview-import", "execute-import"].includes(message?.type) &&
    sender.url === chrome.runtime.getURL("options.html")
  ) {
    if (importBusy) {
      reply({ error: "导入正在进行，请等待完成。" });
      return;
    }
    importBusy = true;
    (async () => {
      const config = await settings();
      const status = await checked(config);
      if (status !== "ok") throw new Error(status);
      const call = (method: string, params = {}, write = false) =>
        gatewayCall(config, method, params, { sideEffecting: write });
      return message.type === "preview-import"
        ? previewImport(call)
        : executeImport(
            call,
            undefined,
            config.glossLanguage,
            config.nativeLanguage,
          );
    })()
      .then(
        (data) => reply({ data }),
        (error) => reply({ error: String(error) }),
      )
      .finally(() => {
        importBusy = false;
      });
  } else return;
  return true;
});
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch {
    /* Chrome internal pages and other protected tabs cannot be injected. */
  }
});

// Serialize changes so quick successive selections cannot finish out of order.
let glossUpdate = Promise.resolve();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes.glossLanguage || changes.nativeLanguage))
    return;
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
