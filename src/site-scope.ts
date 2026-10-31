/**
 * Site scope and the built-in deny list (spec 12.2, 13.1, 14).
 *
 * The deny list only suppresses *automatic* runs (remembered/all site scope).
 * A manual toolbar click always injects the reading script for the current page.
 */
export type SiteScope = "activeTab" | "remembered" | "all";

export const SITE_SCOPES: readonly SiteScope[] = [
  "activeTab",
  "remembered",
  "all",
];

/**
 * Hosts that commonly contain private mail, chat, or password-manager vaults.
 * Entries match the host itself and any subdomain.
 */
export const DEFAULT_DENY_SITES: readonly string[] = [
  "mail.google.com",
  "gmail.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
  "mail.qq.com",
  "web.whatsapp.com",
  "web.telegram.org",
  "discord.com",
  "slack.com",
  "1password.com",
  "bitwarden.com",
  "lastpass.com",
  "dashlane.com",
  "nordpass.com",
  "keepersecurity.com",
  "roboform.com",
  "pass.proton.me",
];

export function isSiteScope(value: unknown): value is SiteScope {
  return SITE_SCOPES.includes(value as SiteScope);
}

/** Parse one editable line into a bare lowercase hostname, or undefined. */
export function normalizeHostEntry(value: string): string | undefined {
  let host = value.trim().toLowerCase();
  if (!host || host.startsWith("#")) return undefined;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/, 1)[0];
  host = host.replace(/:\d+$/, "");
  host = host.replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "");
  if (!host || !/^[a-z0-9._-]+$/.test(host)) return undefined;
  return host;
}

export function parseDenyList(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const host = normalizeHostEntry(line);
    if (host) seen.add(host);
  }
  return [...seen];
}

/** True when `hostname` is the entry itself or one of its subdomains. */
export function hostMatchesDeny(
  hostname: string,
  denyList: readonly string[],
): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return denyList.some(
    (entry) => host === entry || host.endsWith(`.${entry}`),
  );
}

/** Match pattern for an origin permission request and content-script match. */
export function sitePattern(hostname: string): string {
  return `*://${hostname}/*`;
}

export function httpHost(url: string | undefined): string | undefined {
  if (!url || !/^https?:/i.test(url)) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Hosts that should be remembered: valid, still granted, and not denied. */
export function registrationMatches(
  scope: SiteScope,
  rememberedSites: readonly string[],
  denyList: readonly string[],
  grantedOrigins: readonly string[],
): string[] {
  if (scope === "activeTab") return [];
  if (scope === "all")
    return grantedOrigins.includes("*://*/*") ? ["*://*/*"] : [];
  const granted = new Set(grantedOrigins);
  const matches: string[] = [];
  for (const host of rememberedSites) {
    if (hostMatchesDeny(host, denyList)) continue;
    const pattern = sitePattern(host);
    if (!granted.has(pattern)) continue;
    if (!matches.includes(pattern)) matches.push(pattern);
  }
  return matches;
}
