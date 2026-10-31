import type { Settings, Status } from "./background/gateway";
export const t = (key: string) => chrome.i18n.getMessage(key);
import { levels, type ReadingSettings } from "./reading";
export async function settings(): Promise<Settings & ReadingSettings> {
  const value = await chrome.storage.local.get({
    port: 8765,
    apiKey: "",
    nativeLanguage: "zh",
    glossLanguage: "native",
    targetLevel: "B1",
    showAdvanced: false,
    hoverScope: "highlighted",
  });
  return {
    port:
      typeof value.port === "number" &&
      Number.isInteger(value.port) &&
      value.port > 0 &&
      value.port <= 65535
        ? value.port
        : 8765,
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    nativeLanguage: value.nativeLanguage === "en" ? "en" : "zh",
    glossLanguage: value.glossLanguage === "target" ? "target" : "native",
    targetLevel: levels.includes(
      value.targetLevel as ReadingSettings["targetLevel"],
    )
      ? (value.targetLevel as ReadingSettings["targetLevel"])
      : "B1",
    showAdvanced: value.showAdvanced === true,
    hoverScope: value.hoverScope === "all" ? "all" : "highlighted",
  };
}
export const check = (): Promise<Status> =>
  chrome.runtime.sendMessage({ type: "check-connection" });
