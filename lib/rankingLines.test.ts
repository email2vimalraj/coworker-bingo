import { describe, expect, it } from "vitest";
import { rankPlayers, type RankingConfig, type RankingPlayer } from "./ranking";

const START = 1_000_000;
const T = (sec: number) => START + sec * 1000;
const cfg = (over: Partial<RankingConfig> = {}): RankingConfig => ({
  mode: "lines",
  linesToWin: 1,
  requireFullCard: false,
  winnersCount: 3,
  startedAt: START,
  durationSeconds: 600,
  ...over,
});
const ids = (r: { id: string }[]) => r.map((x) => x.id);

const ROW0 = [0, 1, 2, 3, 4];
const ROW1 = [5, 6, 7, 8, 9];
const MID = [10, 11, 13, 14];
const fill = (cells: number[], sec: number) => cells.map((cell) => ({ cell, resolvedAt: T(sec) }));
const lp = (
  id: string,
  confirmed: { cell: number; resolvedAt: number }[],
  submitSec: number | null = null,
  joinedAt = 0,
): RankingPlayer => ({
  id,
  correct: confirmed.length,
  submittedAt: submitSec === null ? null : T(submitSec),
  joinedAt,
  confirmed,
});

describe("rankPlayers: lines mode", () => {
  it("first to complete a line wins; reach time is the line's last confirmation", () => {
    const r = rankPlayers(
      [
        lp("slow", fill(ROW0, 200)),
        lp("fast", [...fill([0, 1, 2, 3], 10), ...fill([4], 100)]),
        lp("mid", fill(MID, 150)), // FREE counts: 4 cells complete the middle row
      ],
      cfg(),
    );
    expect(ids(r)).toEqual(["fast", "mid", "slow"]);
    expect(r.map((x) => x.reachSeconds)).toEqual([100, 150, 200]);
    expect(r.map((x) => x.lines)).toEqual([1, 1, 1]);
    expect(r.map((x) => x.isWinner)).toEqual([true, true, true]);
  });

  it("non-eligible follow, by lines desc, correct desc, elapsed asc", () => {
    const r = rankPlayers(
      [
        lp("none-more", fill([0, 1, 2, 3, 6, 7, 8], 50), 100),
        lp("done", fill(ROW0, 300)),
        lp("none-less", fill([0, 1], 10)),
      ],
      cfg({ winnersCount: 5 }),
    );
    expect(ids(r)).toEqual(["done", "none-more", "none-less"]);
    expect(r.map((x) => x.eligible)).toEqual([true, false, false]);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(r[1].reachSeconds).toBeNull();
  });

  it("lines_to_win = 2 needs two lines; reach is the second completion", () => {
    const r = rankPlayers(
      [
        lp("two", [...fill(ROW0, 100), ...fill(ROW1, 400)]),
        lp("one", fill(ROW0, 20)),
        lp("two-fast", [...fill(ROW0, 50), ...fill(ROW1, 90)]),
      ],
      cfg({ linesToWin: 2, winnersCount: 1 }),
    );
    expect(ids(r)).toEqual(["two-fast", "two", "one"]);
    expect(r.map((x) => x.reachSeconds)).toEqual([90, 400, null]);
    expect(r.map((x) => x.isWinner)).toEqual([true, false, false]);
    expect(r.map((x) => x.lines)).toEqual([2, 2, 1]);
  });

  it("equal reach times share a rank; joinedAt orders them; require_full_card is ignored", () => {
    const r = rankPlayers(
      [lp("b", fill(ROW0, 30), null, 2), lp("a", fill(ROW0, 30), null, 1), lp("c", fill(ROW0, 31), null, 0)],
      cfg({ requireFullCard: true }),
    );
    expect(ids(r)).toEqual(["a", "b", "c"]);
    expect(r.map((x) => x.rank)).toEqual([1, 1, 3]);
    expect(r.every((x) => x.eligible)).toBe(true);
  });
});
