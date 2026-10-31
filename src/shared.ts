import type { Settings, Status } from "./background/gateway";
export const t = (key: string) => chrome.i18n.getMessage(key);
import { levels, type ReadingSettings } from "./reading";
/** Test-only override so full-level acceptance can use throwaway Anki names. */
export type TestImportTarget = { noteType: string; deckPrefix: string };
function testImportTarget(value: unknown): TestImportTarget | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { noteType, deckPrefix } = value as Record<string, unknown>;
  if (
    typeof noteType !== "string" ||
    !/^VOKA .+/.test(noteType) ||
    typeof deckPrefix !== "string" ||
    !/^VOKA::.+/.test(deckPrefix)
  )
    return undefined;
  return { noteType, deckPrefix };
}
export async function settings(): Promise<
  Settings &
    ReadingSettings & { storeFullUrl: boolean; testImportTarget?: TestImportTarget }
> {
  const value = await chrome.storage.local.get({
    port: 8765,
    apiKey: "",
    nativeLanguage: "zh",
    glossLanguage: "native",
    targetLevel: "B1",
    showAdvanced: false,
    hoverScope: "highlighted",
    storeFullUrl: false,
    testImportTarget: null,
  });
  return {
    port:
      typeof value.port === "number" &&
      Number.isInteger(value.port) &&
      value.port > 0 &&
      value.port <= 65535
        ? value.port
        : 8765,
    storeFullUrl: value.storeFullUrl === true,
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
    ...(() => {
      const target = testImportTarget(value.testImportTarget);
      return target ? { testImportTarget: target } : {};
    })(),
  };
}
export const check = (): Promise<Status> =>
  chrome.runtime.sendMessage({ type: "check-connection" });
