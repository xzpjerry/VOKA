import type { Settings, Status } from "./background/gateway";
export const t = (key: string) => chrome.i18n.getMessage(key);
export async function settings(): Promise<Settings> {
  const value = await chrome.storage.local.get({ port: 8765, apiKey: "" });
  return {
    port:
      typeof value.port === "number" &&
      Number.isInteger(value.port) &&
      value.port > 0 &&
      value.port <= 65535
        ? value.port
        : 8765,
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
  };
}
export const check = (): Promise<Status> =>
  chrome.runtime.sendMessage({ type: "check-connection" });
