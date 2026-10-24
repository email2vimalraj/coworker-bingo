/**
 * Ranking rules. Must stay identical to the SQL function `_leaderboard`
 * in supabase/migrations/0001_init.sql.
 *
 * - correct   = confirmed squares (0-24)
 * - elapsed   = submittedAt - startedAt, else the full duration
 * - eligible  = can win: needs at least 1 confirmed square. With requireFullCard or mode full_card_fastest only 24/24 boards.
 * - rank      = competition rank by correct desc, elapsed asc (ties share a rank).
 *               In full_card_fastest only 24/24 boards are ranked (others get null).
 * - isWinner  = eligible and within the first `winnersCount` eligible players
 *               ordered by correct desc, elapsed asc, joinedAt asc.
 * - prizeRank = rank for winners, else null.
 */
export type RankingMode = "correct_then_time" | "full_card_fastest";

export const FULL_CARD = 24;

export interface RankingConfig {
  mode: RankingMode;
  requireFullCard: boolean;
  winnersCount: number;
  /** ms epoch; null if the session never started */
  startedAt: number | null;
  durationSeconds: number;
}

export interface RankingPlayer {
  id: string;
  correct: number;
  /** ms epoch; null if not submitted */
  submittedAt: number | null;
  /** ms epoch, final tiebreak for ordering */
  joinedAt: number;
}

export interface RankedPlayer {
  id: string;
  correct: number;
  elapsedSeconds: number;
  eligible: boolean;
  rank: number | null;
  isWinner: boolean;
  prizeRank: number | null;
}

export function elapsedSeconds(
  startedAt: number | null,
  submittedAt: number | null,
  durationSeconds: number,
): number {
  if (submittedAt !== null && startedAt !== null) return (submittedAt - startedAt) / 1000;
  return durationSeconds;
}

export function rankPlayers(players: RankingPlayer[], cfg: RankingConfig): RankedPlayer[] {
  const fullOnly = cfg.requireFullCard || cfg.mode === "full_card_fastest";
  const rows = players.map((p) => {
    const elapsed = elapsedSeconds(cfg.startedAt, p.submittedAt, cfg.durationSeconds);
    return {
      p,
      elapsed,
      eligible: p.correct >= 1 && (fullOnly ? p.correct === FULL_CARD : true),
      ranked: cfg.mode === "full_card_fastest" ? p.correct === FULL_CARD : true,
    };
  });

  rows.sort(
    (a, b) => b.p.correct - a.p.correct || a.elapsed - b.elapsed || a.p.joinedAt - b.p.joinedAt,
  );

  const out: RankedPlayer[] = [];
  let rankedSeen = 0;
  let eligibleSeen = 0;
  let prev: { correct: number; elapsed: number; rank: number } | null = null;
  for (const r of rows) {
    let rank: number | null = null;
    if (r.ranked) {
      rankedSeen += 1;
      if (prev && prev.correct === r.p.correct && prev.elapsed === r.elapsed) {
        rank = prev.rank;
      } else {
        rank = rankedSeen;
      }
      prev = { correct: r.p.correct, elapsed: r.elapsed, rank };
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
    });
  }
  return out;
}
