/** Local decisions only: never copied to Anki or synced. */
export type UpgradeKept = Record<string, string>;
export function parseUpgradeKept(value: unknown): UpgradeKept {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, version]) =>
    /^\d+$/.test(id) && typeof version === "string" && version.length > 0 && version.length <= 100,
  )) as UpgradeKept;
}
export async function readUpgradeKept(): Promise<UpgradeKept> {
  return parseUpgradeKept((await chrome.storage.local.get({ upgradeKept: {} })).upgradeKept);
}
export async function clearUpgradeKept() {
  await chrome.storage.local.set({ upgradeKept: {} });
}
