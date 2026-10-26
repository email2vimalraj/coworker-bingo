import { describe, expect, it } from "vitest";
import { cellsInCompletedLines, completedLineIndexes, LINES, lineCompletionTimes, reachTime } from "./lines";

describe("LINES", () => {
  it("has 12 distinct lines of 5 cells", () => {
    expect(LINES).toHaveLength(12);
    expect(new Set(LINES.map((l) => l.join(","))).size).toBe(12);
    expect(LINES.every((l) => l.length === 5)).toBe(true);
    expect(LINES[10]).toEqual([0, 6, 12, 18, 24]);
    expect(LINES[11]).toEqual([4, 8, 12, 16, 20]);
  });
});

describe("completedLineIndexes", () => {
  it("counts FREE as filled: the middle row needs only 4 cells", () => {
    expect(completedLineIndexes([10, 11, 13, 14])).toEqual([2]);
  });
  it("detects columns and diagonals", () => {
    expect(completedLineIndexes([0, 5, 10, 15, 20])).toEqual([5]);
    expect(completedLineIndexes([0, 6, 18, 24])).toEqual([10]);
    expect(completedLineIndexes([4, 8, 16, 20])).toEqual([11]);
  });
  it("crossing lines both count", () => {
    expect(completedLineIndexes([10, 11, 13, 14, 2, 7, 17, 22])).toEqual([2, 7]);
  });
  it("nothing complete with a hole", () => {
    expect(completedLineIndexes([0, 1, 2, 3])).toEqual([]);
  });
  it("highlights cells of completed lines", () => {
    expect([...cellsInCompletedLines([10, 11, 13, 14])].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14]);
  });
});

describe("lineCompletionTimes / reachTime", () => {
  const cells = (pairs: [number, number][]) => pairs.map(([cell, resolvedAt]) => ({ cell, resolvedAt }));
  it("line time is the latest resolved_at in the line", () => {
    const t = lineCompletionTimes(cells([[10, 5], [11, 9], [13, 7], [14, 3]]));
    expect(t).toEqual([9]);
  });
  it("sorts completion times and picks the Nth", () => {
    const t = lineCompletionTimes(
      cells([[10, 1], [11, 2], [13, 3], [14, 4], [0, 10], [1, 11], [2, 12], [3, 13], [4, 14]]),
    );
    expect(t).toEqual([4, 14]);
    expect(reachTime(t, 1)).toBe(4);
    expect(reachTime(t, 2)).toBe(14);
    expect(reachTime(t, 3)).toBeNull();
  });
  it("shared cells make several lines complete at once", () => {
    // row 0 and column 0 share cell 0, completed last
    const t = lineCompletionTimes(
      cells([[1, 1], [2, 1], [3, 1], [4, 1], [5, 2], [10, 2], [15, 2], [20, 2], [0, 9]]),
    );
    expect(t).toEqual([9, 9]);
  });
});
