/**
 * Classic bingo lines on the 5x5 board (cells 0..24, row-major, cell 12 is FREE).
 * Mirrors `_bingo_lines()` / `_leaderboard()` in supabase/migrations/0005_lines_mode.sql.
 *
 * A line is complete when all its non-FREE cells are confirmed. Its completion time is the
 * latest `resolvedAt` among those confirmed claims. A player's "reach time" is the moment their
 * Nth line completed, i.e. the Nth smallest completion time.
 */
export const FREE_CELL = 12;
export const MAX_LINES = 12;

function buildLines(): number[][] {
  const lines: number[][] = [];
  for (let r = 0; r < 5; r++) lines.push([0, 1, 2, 3, 4].map((k) => r * 5 + k)); // rows
  for (let k = 0; k < 5; k++) lines.push([0, 1, 2, 3, 4].map((r) => r * 5 + k)); // columns
  lines.push([0, 1, 2, 3, 4].map((i) => i * 6)); // main diagonal
  lines.push([0, 1, 2, 3, 4].map((i) => i * 4 + 4)); // anti diagonal
  return lines;
}

/** The 12 lines (rows 0-4, columns 5-9, diagonals 10-11), FREE cell included. */
export const LINES: readonly (readonly number[])[] = buildLines();

/** Indexes (into LINES) of lines whose non-FREE cells are all in `confirmedCells`. */
export function completedLineIndexes(confirmedCells: Iterable<number>): number[] {
  const set = new Set(confirmedCells);
  const out: number[] = [];
  LINES.forEach((cells, idx) => {
    if (cells.every((c) => c === FREE_CELL || set.has(c))) out.push(idx);
  });
  return out;
}

/** Cells that belong to at least one completed line (for highlighting). */
export function cellsInCompletedLines(confirmedCells: Iterable<number>): Set<number> {
  const out = new Set<number>();
  for (const idx of completedLineIndexes(confirmedCells)) for (const c of LINES[idx]) out.add(c);
  return out;
}

export interface ConfirmedCell {
  cell: number;
  /** ms epoch */
  resolvedAt: number;
}

/** Completion time (ms epoch) of every completed line, ascending. */
export function lineCompletionTimes(confirmed: ConfirmedCell[]): number[] {
  const at = new Map<number, number>();
  for (const c of confirmed) at.set(c.cell, c.resolvedAt);
  const times: number[] = [];
  for (const cells of LINES) {
    let latest = -Infinity;
    let complete = true;
    for (const c of cells) {
      if (c === FREE_CELL) continue;
      const t = at.get(c);
      if (t === undefined) {
        complete = false;
        break;
      }
      if (t > latest) latest = t;
    }
    if (complete) times.push(latest);
  }
  return times.sort((a, b) => a - b);
}

/** The moment the Nth line completed, or null if fewer than N lines are complete. */
export function reachTime(sortedTimes: number[], linesToWin: number): number | null {
  return sortedTimes.length >= linesToWin ? sortedTimes[linesToWin - 1] : null;
}
