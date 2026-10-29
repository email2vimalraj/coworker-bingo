import { describe, expect, it } from "vitest";
import { isRevealed } from "./results";

describe("isRevealed", () => {
  it("hidden by default", () => expect(isRevealed({})).toBe(false));
  it("hidden with option off and no reveal", () =>
    expect(isRevealed({ present_show_leaderboard: false, results_revealed_at: null })).toBe(false));
  it("revealed by the Top 10 option", () => expect(isRevealed({ present_show_leaderboard: true })).toBe(true));
  it("revealed by the host", () => expect(isRevealed({ results_revealed_at: "2026-10-29T10:00:00Z" })).toBe(true));
})
