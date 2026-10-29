import type { RankedPlayer } from "./ranking";

/**
 * Host-picked winners (migration 0018). The ranking rules in lib/ranking.ts are unchanged; picks are a layer
 * on top: automatic winners keep places 1..k and the host fills k+1..winnersCount by hand.
 */
export interface HostPick {
  id: string;
  /** award_place (1..winnersCount) */
  place: number;
}

export interface PrizedPlayer extends RankedPlayer {
  /** the place the host gave, if any */
  awardPlace: number | null;
  /** winner only because the host picked them (not by the rules) */
  hostPick: boolean;
  /** automatic winners: position 1..k; host picks: their award place; others null */
  prizePlace: number | null;
}

/** Mirrors the SQL `_leaderboard` output columns award_place / host_pick / prize_place and is_winner. */
export function applyHostPicks(ranked: RankedPlayer[], picks: HostPick[]): PrizedPlayer[] {
  const placeById = new Map(picks.map((p) => [p.id, p.place]));
  let auto = 0;
  return ranked.map((r) => {
    const awardPlace = placeById.get(r.id) ?? null;
    if (r.isWinner) auto += 1;
    return {
      ...r,
      isWinner: r.isWinner || awardPlace !== null,
      awardPlace,
      hostPick: awardPlace !== null && !r.isWinner,
      prizePlace: r.isWinner ? auto : awardPlace,
    };
  });
}

export interface PrizeSummary {
  /** winners found by the rules */
  automatic: number;
  /** winners chosen by the host */
  picked: number;
  /** prize places nobody holds yet */
  empty: number;
  /** the place the next "Give prize" would take, or null when none is free */
  nextPlace: number | null;
}

interface SummaryRow {
  is_winner: boolean;
  host_pick: boolean;
  award_place: number | null;
}

/** Counts automatic winners, host picks and empty places from leaderboard rows. */
export function prizeSummary(rows: SummaryRow[], winnersCount: number): PrizeSummary {
  const automatic = rows.filter((r) => r.is_winner && !r.host_pick).length;
  const taken = new Set(rows.filter((r) => r.host_pick && r.award_place !== null).map((r) => r.award_place));
  let nextPlace: number | null = null;
  for (let p = automatic + 1; p <= winnersCount; p++) {
    if (!taken.has(p)) {
      nextPlace = p;
      break;
    }
  }
  const picked = taken.size;
  return { automatic, picked, empty: Math.max(0, winnersCount - automatic - picked), nextPlace };
}
