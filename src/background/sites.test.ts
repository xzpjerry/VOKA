import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { rememberSite, scheduleSiteSync, shouldAutoRun } from "./sites";

let config: Record<string, unknown>;
let granted: boolean;
let request: ReturnType<typeof vi.fn>;
let register: ReturnType<typeof vi.fn>;
beforeEach(() => {
  config = { siteScope: "remembered", rememberedSites: ["example.com"], denyList: ["mail.google.com"] };
  granted = true;
  request = vi.fn(async () => granted);
  register = vi.fn(async () => {});
  vi.stubGlobal("chrome", {
    storage: { local: {
      get: vi.fn(async (defaults) => ({ ...defaults, ...config })),
      set: vi.fn(async (changes) => Object.assign(config, changes)),
    } },
    permissions: {
      request,
      contains: vi.fn(async () => granted),
      getAll: vi.fn(async () => ({ origins: ["*://*/*"] })),
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(async () => []),
      registerContentScripts: register,
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("requests permission immediately and only remembers an accepted grant", async () => {
  granted = false;
  const pending = rememberSite("new.example");
  expect(request).toHaveBeenCalledWith({ origins: ["*://new.example/*"] });
  expect(await pending).toBe(false);
  expect(config.rememberedSites).toEqual(["example.com"]);
  granted = true;
  expect(await rememberSite("new.example")).toBe(true);
  expect(config.rememberedSites).toEqual(["example.com", "new.example"]);
});

it("blocks denied auto-runs despite a remembered grant", async () => {
  config.rememberedSites = ["mail.google.com"];
  expect(await shouldAutoRun("https://mail.google.com/mail/")).toBe(false);
  expect(await shouldAutoRun("chrome://extensions")).toBe(false);
});

it("checks live permission before each auto-run", async () => {
  expect(await shouldAutoRun("https://example.com/")).toBe(true);
  granted = false;
  expect(await shouldAutoRun("https://example.com/")).toBe(false);
});

it("registers remembered sites covered by a broader grant", async () => {
  await scheduleSiteSync();
  expect(register).toHaveBeenCalledWith([expect.objectContaining({
    matches: ["*://example.com/*"], persistAcrossSessions: true,
  })]);
  config.siteScope = "activeTab";
  register.mockClear();
  await scheduleSiteSync();
  expect(register).not.toHaveBeenCalled();
});

it("offers recovery only for an unready remembered toolbar without a grant", async () => {
  const { recoverColdToolbar } = await import("./sites");
  const offer = vi.fn(async () => {});
  granted = false;
  await recoverColdToolbar(false, "new.example", offer);
  expect(offer).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
  offer.mockClear();
  config.siteScope = "activeTab";
  await recoverColdToolbar(false, "new.example", offer);
  expect(offer).not.toHaveBeenCalled();
  config.siteScope = "remembered";
  await recoverColdToolbar(true, "new.example", offer);
  expect(offer).not.toHaveBeenCalled();
  granted = true;
  await recoverColdToolbar(false, "new.example", offer);
  expect(offer).not.toHaveBeenCalled();
  expect(config.rememberedSites).toContain("new.example");
  expect(request).not.toHaveBeenCalled();
});
