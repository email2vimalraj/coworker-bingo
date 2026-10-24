import { describe, expect, it } from "vitest";
import {
  CODE_ALPHABET,
  joinUrl,
  normalizePlayerCode,
  normalizeSessionCode,
  playerQrUrl,
} from "./codes";

describe("codes", () => {
  it("alphabet excludes 0 O 1 I L", () => {
    for (const ch of "0O1IL") expect(CODE_ALPHABET).not.toContain(ch);
    expect(CODE_ALPHABET).toHaveLength(31);
  });

  it("normalizes player codes case-insensitively, with or without dash", () => {
    expect(normalizePlayerCode("qx7-4pm")).toBe("QX7-4PM");
    expect(normalizePlayerCode("QX74PM")).toBe("QX7-4PM");
    expect(normalizePlayerCode("  qx7 4pm ")).toBe("QX7-4PM");
  });

  it("extracts the code from a URL", () => {
    const url = playerQrUrl("https://bingo.app", "K7PQ2X", "QX7-4PM");
    expect(normalizePlayerCode(url)).toBe("QX7-4PM");
    expect(normalizePlayerCode("https://x.io/play/K7PQ2X/scan?foo=1&c=qx74pm#h")).toBe("QX7-4PM");
  });

  it("rejects invalid codes", () => {
    expect(normalizePlayerCode("")).toBeNull();
    expect(normalizePlayerCode("QX7-4P")).toBeNull();
    expect(normalizePlayerCode("QX7-4PMM")).toBeNull();
    expect(normalizePlayerCode("QX0-4PM")).toBeNull(); // 0 not in alphabet
  });

  it("normalizes session codes and join URLs", () => {
    expect(normalizeSessionCode("k7pq2x")).toBe("K7PQ2X");
    expect(normalizeSessionCode(joinUrl("https://bingo.app", "K7PQ2X"))).toBe("K7PQ2X");
    expect(normalizeSessionCode("K7PQ2")).toBeNull();
    expect(normalizeSessionCode("K7PQ2O")).toBeNull();
  });
});
