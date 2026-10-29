import { describe, expect, it } from "vitest";
import { applyHostPicks, prizeSummary } from "./prizes";
import { rankPlayers } from "./ranking";

const cfg = { mode: "correct_then_time" as const, requireFullCard: true, winnersCount: 3, startedAt: 0, durationSeconds: 600 };
const mk = (id: string, correct: number, joinedAt: number) => ({ id, correct, submittedAt: null, joinedAt });

describe("applyHostPicks", () => {
  it("leaves the rules untouched and marks picks", () => {
    const ranked = rankPlayers([mk("a", 5, 1), mk("b", 3, 2), mk("c", 0, 3), mk("d", 24, 4)], cfg);
    const out = applyHostPicks(ranked, [
      { id: "a", place: 2 },
      { id: "c", place: 3 },
    ]);
    const by = Object.fromEntries(out.map((r) => [r.id, r]));
    expect(by.d).toMatchObject({ isWinner: true, hostPick: false, prizePlace: 1, awardPlace: null });
    expect(by.a).toMatchObject({ isWinner: true, hostPick: true, prizePlace: 2, awardPlace: 2 });
    expect(by.c).toMatchObject({ isWinner: true, hostPick: true, prizePlace: 3, rank: ranked.find((r) => r.id === "c")!.rank });
    expect(by.b).toMatchObject({ isWinner: false, hostPick: false, prizePlace: null });
    expect(out.map((r) => r.rank)).toEqual(ranked.map((r) => r.rank));
  });

  it("no picks: only automatic winners, places 1..k", () => {
    const ranked = rankPlayers([mk("a", 24, 1), mk("b", 24, 2)], cfg);
    const out = applyHostPicks(ranked, []);
    expect(out.map((r) => r.prizePlace)).toEqual([1, 2]);
    expect(out.every((r) => !r.hostPick)).toBe(true);
  });
});

describe("prizeSummary", () => {
  const row = (is_winner: boolean, host_pick: boolean, award_place: number | null) => ({ is_winner, host_pick, award_place });
  it("counts empty places and finds the next free one", () => {
    expect(prizeSummary([row(true, false, null), row(false, false, null)], 3)).toEqual({ automatic: 1, picked: 0, empty: 2, nextPlace: 2 });
    expect(prizeSummary([row(true, false, null), row(true, true, 3)], 3)).toEqual({ automatic: 1, picked: 1, empty: 1, nextPlace: 2 });
    expect(prizeSummary([row(true, true, 1), row(true, true, 2)], 2)).toMatchObject({ empty: 0, nextPlace: null });
    expect(prizeSummary([], 3)).toEqual({ automatic: 0, picked: 0, empty: 3, nextPlace: 1 });
  });
});
