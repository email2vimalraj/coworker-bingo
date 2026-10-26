import { describe, expect, it } from "vitest";
import { pausedSeconds, rankPlayers, secondsSince, type RankingConfig } from "./ranking";

const START = 1_000_000;
const T = (sec: number) => START + sec * 1000;

describe("pausedSeconds / secondsSince", () => {
  const pauses = [
    { start: T(100), end: T(160) },
    { start: T(300), end: null },
  ];
  it("counts only the overlap with [from, to]", () => {
    expect(pausedSeconds(pauses, T(0), T(50))).toBe(0);
    expect(pausedSeconds(pauses, T(0), T(130))).toBe(30);
    expect(pausedSeconds(pauses, T(0), T(200))).toBe(60);
    expect(pausedSeconds(pauses, T(120), T(200))).toBe(40);
  });
  it("an open pause counts up to the target moment", () => {
    expect(pausedSeconds(pauses, T(0), T(400))).toBe(160);
  });
  it("secondsSince subtracts paused time", () => {
    expect(secondsSince(START, T(250), pauses)).toBe(190);
    expect(secondsSince(START, T(250))).toBe(250);
  });
});

describe("rankPlayers with pauses", () => {
  const cfg: RankingConfig = {
    mode: "correct_then_time",
    requireFullCard: false,
    winnersCount: 3,
    startedAt: START,
    durationSeconds: 600,
    pauses: [{ start: T(100), end: T(200) }],
  };
  it("excludes paused time from submit elapsed", () => {
    const r = rankPlayers(
      [
        { id: "late", correct: 5, submittedAt: T(250), joinedAt: 1 }, // 250 - 100 = 150 active
        { id: "early", correct: 5, submittedAt: T(180), joinedAt: 2 }, // 180 - 80 = 100 active
      ],
      cfg,
    );
    expect(r.map((x) => x.id)).toEqual(["early", "late"]);
    expect(r.map((x) => x.elapsedSeconds)).toEqual([100, 150]);
  });
  it("lines reach time excludes pauses", () => {
    const row = (t: number) => [0, 1, 2, 3, 4].map((cell) => ({ cell, resolvedAt: T(t) }));
    const r = rankPlayers(
      [{ id: "a", correct: 5, submittedAt: null, joinedAt: 1, confirmed: row(300) }],
      { ...cfg, mode: "lines", linesToWin: 1 },
    );
    expect(r[0].reachSeconds).toBe(200);
  });
});
