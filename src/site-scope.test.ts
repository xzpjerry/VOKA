import { describe, it, expect } from "vitest";
import {
  DEFAULT_DENY_SITES,
  hostMatchesDeny,
  httpHost,
  normalizeHostEntry,
  parseDenyList,
  registrationMatches,
  sitePattern,
} from "./site-scope";

describe("site scope", () => {
  it("builds origin patterns", () => {
    expect(sitePattern("example.com")).toBe("*://example.com/*");
    expect(httpHost("https://Example.COM/path?q=1")).toBe("example.com");
    expect(httpHost("http://localhost:8080/")).toBe("localhost");
    expect(httpHost("chrome://extensions")).toBeUndefined();
    expect(httpHost("file:///tmp/page.html")).toBeUndefined();
  });

  it("normalizes editable deny entries", () => {
    expect(normalizeHostEntry("  Mail.Google.COM  ")).toBe("mail.google.com");
    expect(normalizeHostEntry("https://mail.google.com/mail/u/0/")).toBe(
      "mail.google.com",
    );
    expect(normalizeHostEntry("*.example.com")).toBe("example.com");
    expect(normalizeHostEntry("# comment")).toBeUndefined();
    expect(normalizeHostEntry("not a host")).toBeUndefined();
    expect(parseDenyList("Gmail.com\n\ngmail.com\nbad host\nweb.whatsapp.com"))
      .toEqual(["gmail.com", "web.whatsapp.com"]);
  });

  it("matches a host and its subdomains only", () => {
    expect(hostMatchesDeny("mail.google.com", DEFAULT_DENY_SITES)).toBe(true);
    expect(hostMatchesDeny("google.com", DEFAULT_DENY_SITES)).toBe(false);
    expect(hostMatchesDeny("app.slack.com", DEFAULT_DENY_SITES)).toBe(true);
    expect(hostMatchesDeny("notslack.com", ["slack.com"])).toBe(false);
    expect(hostMatchesDeny("vault.bitwarden.com", DEFAULT_DENY_SITES)).toBe(
      true,
    );
  });

  it("plans registrations per scope and granted origins", () => {
    const grants = [
      "*://example.com/*",
      "*://denied.example/*",
      "*://*.other.test/*",
    ];
    expect(registrationMatches("activeTab", ["example.com"], [], grants)).toEqual(
      [],
    );
    expect(
      registrationMatches(
        "remembered",
        ["example.com", "denied.example", "missing.example", "other.test"],
        ["denied.example"],
        grants,
      ),
    ).toEqual(["*://example.com/*"]);
    expect(registrationMatches("all", [], [], [])).toEqual([]);
    expect(registrationMatches("all", [], [], ["*://*/*"])).toEqual([
      "*://*/*",
    ]);
  });
});
