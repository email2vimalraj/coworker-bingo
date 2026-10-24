import { describe, expect, it } from "vitest";
import { rankPlayers, type RankingConfig, type RankingPlayer } from "./ranking";

const START = 1_000_000;
const cfg = (over: Partial<RankingConfig> = {}): RankingConfig => ({
  mode: "correct_then_time",
  requireFullCard: false,
  winnersCount: 3,
  startedAt: START,
  durationSeconds: 600,
  ...over,
});
const player = (
  id: string,
  correct: number,
  submitSec: number | null,
  joinedAt = 0,
): RankingPlayer => ({
  id,
  correct,
  submittedAt: submitSec === null ? null : START + submitSec * 1000,
  joinedAt,
});
const ids = (r: { id: string }[]) => r.map((x) => x.id);

describe("rankPlayers", () => {
  it("4.5 min beats 4.9 min on equal score", () => {
    const r = rankPlayers([player("b", 24, 4.9 * 60), player("a", 24, 4.5 * 60)], cfg());
    expect(ids(r)).toEqual(["a", "b"]);
    expect(r.map((x) => x.rank)).toEqual([1, 2]);
  });

  it("higher correct beats faster time in correct_then_time", () => {
    const r = rankPlayers([player("fast", 10, 30), player("full", 12, 500)], cfg());
    expect(ids(r)).toEqual(["full", "fast"]);
  });

  it("ties share a rank; joinedAt orders them and the next rank skips", () => {
    const r = rankPlayers(
      [player("c", 5, 100, 3), player("a", 5, 100, 1), player("b", 5, 100, 2), player("d", 4, 50)],
      cfg({ winnersCount: 2 }),
    );
    expect(ids(r)).toEqual(["a", "b", "c", "d"]);
    expect(r.map((x) => x.rank)).toEqual([1, 1, 1, 4]);
    expect(r.map((x) => x.isWinner)).toEqual([true, true, false, false]);
    expect(r.map((x) => x.prizeRank)).toEqual([1, 1, null, null]);
  });

  it("require_full_card: partial boards are listed but cannot win", () => {
    const r = rankPlayers(
      [player("p", 23, 10), player("f1", 24, 400), player("f2", 24, 300)],
      cfg({ requireFullCard: true, winnersCount: 3 }),
    );
    expect(ids(r)).toEqual(["f2", "f1", "p"]);
    expect(r.map((x) => x.isWinner)).toEqual([true, true, false]);
    expect(r.map((x) => x.eligible)).toEqual([true, true, false]);
    expect(r[2].rank).toBe(3);
  });

  it("full_card_fastest: only 24/24 are ranked, ordered by time", () => {
    const r = rankPlayers(
      [player("p", 23, 5), player("f1", 24, 400), player("f2", 24, 300)],
      cfg({ mode: "full_card_fastest" }),
    );
    expect(ids(r)).toEqual(["f2", "f1", "p"]);
    expect(r.map((x) => x.rank)).toEqual([1, 2, null]);
    expect(r.map((x) => x.isWinner)).toEqual([true, true, false]);
  });

  it("winners_count limits winners", () => {
    const ps = [1, 2, 3, 4, 5].map((n) => player(`p${n}`, 24, n * 10));
    const r = rankPlayers(ps, cfg({ winnersCount: 2 }));
    expect(r.filter((x) => x.isWinner).map((x) => x.id)).toEqual(["p1", "p2"]);
    expect(r.filter((x) => x.prizeRank !== null).map((x) => x.prizeRank)).toEqual([1, 2]);
  });

  it("non-submitters get the full duration", () => {
    const r = rankPlayers([player("n", 24, null), player("s", 24, 599)], cfg());
    expect(ids(r)).toEqual(["s", "n"]);
    expect(r[1].elapsedSeconds).toBe(600);
    expect(r[0].elapsedSeconds).toBe(599);
  });

  it("submitting early with fewer squares still loses to more squares", () => {
    const r = rankPlayers([player("a", 3, 1), player("b", 4, null)], cfg());
    expect(ids(r)).toEqual(["b", "a"]);
  });
});
