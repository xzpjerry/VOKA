import { checkConnection } from "./gateway";
import { settings } from "../shared";
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "check-connection")
    return;
  settings()
    .then(checkConnection)
    .then(reply, () => reply("unreachable"));
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
