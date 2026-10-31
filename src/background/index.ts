import { previewImport, executeImport } from "./import";
import { checkConnection, rpc } from "./gateway";
import { settings } from "../shared";
let importBusy = false;
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "check-connection") {
    settings()
      .then(checkConnection)
      .then(reply, () => reply("unreachable"));
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
      const status = await checkConnection(config);
      if (status !== "ok") throw new Error(status);
      const call = (method: string, params = {}, write = false) =>
        rpc(config, method, params, { sideEffecting: write });
      return message.type === "preview-import"
        ? previewImport(call)
        : executeImport(call);
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
