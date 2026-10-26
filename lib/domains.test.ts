import { describe, expect, it } from "vitest";
import { describeDomains, emailDomainAllowed, parseDomains } from "./domains";

describe("parseDomains", () => {
  it("splits on commas and spaces, lowercases and dedupes", () => {
    expect(parseDomains("Acme.com, acme.co.uk  ACME.com\nfoo-bar.io").domains).toEqual([
      "acme.com",
      "acme.co.uk",
      "foo-bar.io",
    ]);
  });
  it("flags entries with @ or no dot", () => {
    const r = parseDomains("@acme.com localhost ok.com -x.com");
    expect(r.domains).toEqual(["ok.com"]);
    expect(r.invalid).toEqual(["@acme.com", "localhost", "-x.com"]);
  });
  it("empty input is no restriction", () => {
    expect(parseDomains("  ")).toEqual({ domains: [], invalid: [] });
  });
});

describe("emailDomainAllowed", () => {
  it("allows anything when the list is empty", () => {
    expect(emailDomainAllowed("a@b.com", [])).toBe(true);
  });
  it("requires an exact domain match", () => {
    const allowed = ["acme.com"];
    expect(emailDomainAllowed("Al@ACME.com", allowed)).toBe(true);
    expect(emailDomainAllowed("al@mail.acme.com", allowed)).toBe(false);
    expect(emailDomainAllowed("al@notacme.com", allowed)).toBe(false);
    expect(emailDomainAllowed("al@acme.com.evil.io", allowed)).toBe(false);
    expect(emailDomainAllowed("nope", allowed)).toBe(false);
  });
});

describe("describeDomains", () => {
  it("formats", () => expect(describeDomains(["a.com", "b.io"])).toBe("@a.com or @b.io"));
});
