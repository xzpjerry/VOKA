import { settings } from "../shared";
import {
  hostMatchesDeny,
  httpHost,
  registrationMatches,
  sitePattern,
} from "../site-scope";

const SCRIPT_ID = "voka-site-auto";

async function syncNow() {
  let registered: chrome.scripting.RegisteredContentScript[] = [];
  try {
    registered = await chrome.scripting.getRegisteredContentScripts();
  } catch {
    /* scripting is a required permission; keep the failure non-fatal. */
  }
  const stale = registered
    .filter((script) => script.id === SCRIPT_ID)
    .map((script) => script.id);
  if (stale.length) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: stale });
    } catch {
      /* A concurrent browser-side removal is harmless. */
    }
  }
  const config = await settings();
  const all = await chrome.permissions.getAll();
  // contains() accounts for broader grants (for example switching from all
  // sites back to remembered), unlike comparing getAll() strings literally.
  const effectiveOrigins = config.siteScope === "remembered"
    ? (await Promise.all(config.rememberedSites.map(async (host) => {
        const pattern = sitePattern(host);
        return await chrome.permissions.contains({ origins: [pattern] })
          ? pattern : undefined;
      }))).filter((pattern): pattern is string => !!pattern)
    : all.origins ?? [];
  const matches = registrationMatches(
    config.siteScope,
    config.rememberedSites,
    config.denyList,
    effectiveOrigins,
  );
  if (!matches.length) return;
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: SCRIPT_ID,
        matches,
        js: ["content-auto.js"],
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
    ]);
  } catch (error) {
    console.error("VOKA could not register automatic content scripts", error);
  }
}

// Registrations and permission events can overlap; apply them in order.
let syncQueue: Promise<void> = Promise.resolve();
export function scheduleSiteSync(): Promise<void> {
  syncQueue = syncQueue.then(syncNow, syncNow);
  return syncQueue.catch((error) =>
    console.error("VOKA site-scope sync failed", error),
  );
}

/**
 * Called from the popup toggle click, inside its user gesture. Requests host access
 * for the current site and records it for remembered mode.
 */
export async function rememberSite(host: string): Promise<boolean> {
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [sitePattern(host)] });
  } catch (error) {
    console.error("VOKA site permission request failed", error);
    return false;
  }
  if (!granted) return false;
  await recordRememberedSite(host);
  return true;
}

async function recordRememberedSite(host: string): Promise<void> {
  const config = await settings();
  await chrome.storage.local.set({
    rememberedSites: [...new Set([...config.rememberedSites, host])],
    ...(config.siteScope === "activeTab" ? { siteScope: "remembered" } : {}),
  });
  await scheduleSiteSync();
}

/** Disable this host, including when a broader all-sites grant remains. */
export async function forgetSite(host: string): Promise<void> {
  const config = await settings();
  await chrome.storage.local.set({
    rememberedSites: config.rememberedSites.filter(site => site !== host),
    ...(config.siteScope === "all" ? { denyList: [...new Set([...config.denyList, host])] } : {}),
  });
  await chrome.permissions.remove({ origins: [sitePattern(host)] });
  await scheduleSiteSync();
}

/** Guard used by content-auto.js before it starts reading a page. */
export async function shouldAutoRun(url: string | undefined): Promise<boolean> {
  const host = httpHost(url);
  if (!host) return false;
  const config = await settings();
  if (config.siteScope === "activeTab") return false;
  if (hostMatchesDeny(host, config.denyList)) return false;
  if (config.siteScope === "remembered") {
    if (!config.rememberedSites.includes(host)) return false;
    return chrome.permissions.contains({ origins: [sitePattern(host)] });
  }
  return chrome.permissions.contains({ origins: ["*://*/*"] });
}
