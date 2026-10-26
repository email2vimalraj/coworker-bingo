import { lineCompletionTimes, reachTime, type ConfirmedCell } from "./lines";

/**
 * Ranking rules. Must stay identical to the SQL function `_leaderboard`
 * (latest definition: supabase/migrations/0005_lines_mode.sql).
 *
 * - correct   = confirmed squares (0-24)
 * - elapsed   = submittedAt - startedAt, else the full duration
 * - eligible  = can win: needs at least 1 confirmed square. With requireFullCard or mode full_card_fastest only 24/24 boards.
 * - rank      = competition rank by correct desc, elapsed asc (ties share a rank).
 *               In full_card_fastest only 24/24 boards are ranked (others get null).
 * - isWinner  = eligible and within the first `winnersCount` eligible players
 *               ordered by correct desc, elapsed asc, joinedAt asc.
 * - prizeRank = rank for winners, else null.
 *
 * Mode "lines" (classic bingo, lib/lines.ts): lines = completed rows/columns/diagonals (FREE counts).
 * eligible = correct >= 1 and lines >= linesToWin. Eligible players come first, ordered by
 * reachSeconds (when their linesToWin-th line completed, seconds since start) then joinedAt;
 * then the rest by lines desc, correct desc, elapsed asc, joinedAt. Ties share a rank.
 * requireFullCard is ignored. reachSeconds is only set for eligible players in this mode.
 */
export type RankingMode = "correct_then_time" | "full_card_fastest" | "lines";

export const FULL_CARD = 24;

export interface RankingConfig {
  mode: RankingMode;
  requireFullCard: boolean;
  winnersCount: number;
  /** ms epoch; null if the session never started */
  startedAt: number | null;
  durationSeconds: number;
  /** lines mode: lines needed to win (1-12), default 1 */
  linesToWin?: number;
}

export interface RankingPlayer {
  id: string;
  correct: number;
  /** ms epoch; null if not submitted */
  submittedAt: number | null;
  /** ms epoch, final tiebreak for ordering */
  joinedAt: number;
  /** lines mode: confirmed squares with their resolved time (ms epoch) */
  confirmed?: ConfirmedCell[];
}

export interface RankedPlayer {
  id: string;
  correct: number;
  elapsedSeconds: number;
  eligible: boolean;
  rank: number | null;
  isWinner: boolean;
  prizeRank: number | null;
  /** completed lines (0 outside lines mode) */
  lines: number;
  /** lines mode, eligible players only: seconds from start to the linesToWin-th line */
  reachSeconds: number | null;
}

export function elapsedSeconds(
  startedAt: number | null,
  submittedAt: number | null,
  durationSeconds: number,
): number {
  if (submittedAt !== null && startedAt !== null) return (submittedAt - startedAt) / 1000;
  return durationSeconds;
}

/** Seconds from `startedAt` to `at` (ms epoch). */
export function secondsSince(startedAt: number | null, at: number): number {
  return startedAt === null ? 0 : (at - startedAt) / 1000;
}

export function rankPlayers(players: RankingPlayer[], cfg: RankingConfig): RankedPlayer[] {
  const isLines = cfg.mode === "lines";
  const linesToWin = cfg.linesToWin ?? 1;
  const fullOnly = cfg.requireFullCard || cfg.mode === "full_card_fastest";
  const rows = players.map((p) => {
    const elapsed = elapsedSeconds(cfg.startedAt, p.submittedAt, cfg.durationSeconds);
    let lines = 0;
    let reach: number | null = null;
    if (isLines) {
      const times = lineCompletionTimes(p.confirmed ?? []);
      lines = times.length;
      const at = reachTime(times, linesToWin);
      reach = at === null ? null : secondsSince(cfg.startedAt, at);
    }
    const eligible =
      p.correct >= 1 && (isLines ? lines >= linesToWin : fullOnly ? p.correct === FULL_CARD : true);
    const eligLines = isLines && eligible;
    const nonEligLines = isLines && !eligible;
    // Sort key, compared left to right; identical to the SQL k_* columns.
    const key = [
      nonEligLines ? 1 : 0,
      eligLines ? (reach ?? 0) : 0,
      nonEligLines ? -lines : 0,
      eligLines ? 0 : -p.correct,
      eligLines ? 0 : elapsed,
    ];
    return {
      p,
      elapsed,
      lines,
      reach,
      key,
      eligible,
      ranked: cfg.mode === "full_card_fastest" ? p.correct === FULL_CARD : true,
    };
  });

  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  rows.sort((a, b) => cmp(a.key, b.key) || a.p.joinedAt - b.p.joinedAt);

  const out: RankedPlayer[] = [];
  let rankedSeen = 0;
  let eligibleSeen = 0;
  let prev: { key: number[]; rank: number } | null = null;
  for (const r of rows) {
    let rank: number | null = null;
    if (r.ranked) {
      rankedSeen += 1;
      if (prev && cmp(prev.key, r.key) === 0) {
        rank = prev.rank;
      } else {
        rank = rankedSeen;
      }
      prev = { key: r.key, rank };
    }
    let isWinner = false;
    if (r.eligible) {
      eligibleSeen += 1;
      isWinner = eligibleSeen <= cfg.winnersCount;
    }
    out.push({
      id: r.p.id,
      correct: r.p.correct,
      elapsedSeconds: r.elapsed,
      eligible: r.eligible,
      rank,
      isWinner,
      prizeRank: isWinner ? rank : null,
      lines: r.lines,
      reachSeconds: isLines && r.eligible ? r.reach : null,
    });
  }
  return out;
}
