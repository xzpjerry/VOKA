import { parseUpgradeKept, type UpgradeKept } from "./upgrade-kept";
import type { Settings, Status } from "./background/gateway";
import {
  DEFAULT_DENY_SITES,
  isSiteScope,
  normalizeHostEntry,
  type SiteScope,
} from "./site-scope";
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
export type SiteSettings = {
  siteScope: SiteScope;
  denyList: string[];
  rememberedSites: string[];
};
export async function settings(): Promise<
  Settings &
    ReadingSettings &
    SiteSettings & {
      upgradeKept: UpgradeKept;
      storeFullUrl: boolean;
      youtubeDiagnostics: boolean;
      youtubeAutoResume: boolean;
      testImportTarget?: TestImportTarget;
    }
> {
  const value = await chrome.storage.local.get({
    upgradeKept: {},
    port: 8765,
    apiKey: "",
    nativeLanguage: "zh",
    glossLanguage: "native",
    targetLevel: "B1",
    showAdvanced: false,
    hoverScope: "highlighted",
    storeFullUrl: false,
    youtubeDiagnostics: false,
    youtubeAutoResume: true,
    testImportTarget: null,
    siteScope: "activeTab",
    denyList: [...DEFAULT_DENY_SITES],
    rememberedSites: [],
  });
  return {
    upgradeKept: parseUpgradeKept(value.upgradeKept),
    port:
      typeof value.port === "number" &&
      Number.isInteger(value.port) &&
      value.port > 0 &&
      value.port <= 65535
        ? value.port
        : 8765,
    storeFullUrl: value.storeFullUrl === true,
    youtubeDiagnostics: value.youtubeDiagnostics === true,
    youtubeAutoResume: value.youtubeAutoResume !== false,
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
    siteScope: isSiteScope(value.siteScope) ? value.siteScope : "activeTab",
    denyList: Array.isArray(value.denyList)
      ? [
          ...new Set(
            value.denyList
              .filter((entry: unknown): entry is string => typeof entry === "string")
              .map(normalizeHostEntry)
              .filter((entry: string | undefined): entry is string => !!entry),
          ),
        ]
      : [...DEFAULT_DENY_SITES],
    rememberedSites: Array.isArray(value.rememberedSites)
      ? [
          ...new Set(
            value.rememberedSites
              .filter((entry: unknown): entry is string => typeof entry === "string")
              .map(normalizeHostEntry)
              .filter((entry: string | undefined): entry is string => !!entry),
          ),
        ]
      : [],
  };
}
export const check = (): Promise<Status> =>
  chrome.runtime.sendMessage({ type: "check-connection" });
