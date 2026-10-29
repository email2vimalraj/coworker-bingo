/** Mirrors the SQL rule (0018): results are visible when the Top 10 option is on or the host has revealed them. */
export function isRevealed(s: { present_show_leaderboard?: boolean | null; results_revealed_at?: string | null }): boolean {
  return s.present_show_leaderboard === true || !!s.results_revealed_at;
}
