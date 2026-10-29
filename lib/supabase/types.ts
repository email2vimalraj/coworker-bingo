/** Hand-written types for the tables and RPC results used by the UI (see supabase/migrations/0001_init.sql). */
import type { RankingMode } from "@/lib/ranking";

export type SessionStatus = "lobby" | "live" | "ended";
export type ClaimStatus = "pending" | "confirmed" | "rejected" | "expired";

export interface SessionRow {
  id: string;
  code: string;
  name: string;
  duration_seconds: number;
  status: SessionStatus;
  started_at: string | null;
  ends_at: string | null;
  ended_at: string | null;
  ranking_mode: RankingMode;
  require_full_card: boolean;
  winners_count: number;
  max_squares_per_coworker: number;
  allowed_email_domains: string[];
  lines_to_win: number;
  allow_username_claims: boolean;
  /** Show the live Top 10 on the Present screen during the game (0017). */
  present_show_leaderboard?: boolean;
  paused_at: string | null;
  created_at: string;
}

export interface JoinInfo {
  name: string;
  status: SessionStatus;
  allowed_email_domains: string[];
}

export interface JoinResult {
  player_id: string;
  player_token: string;
  player_code: string;
  session_code: string;
}

export interface PollSession {
  code: string;
  name: string;
  status: SessionStatus;
  started_at: string | null;
  ends_at: string | null;
  duration_seconds: number;
  winners_count: number;
  max_squares_per_coworker: number;
  ranking_mode: RankingMode;
  lines_to_win: number;
  require_full_card: boolean;
  allow_username_claims: boolean;
  paused: boolean;
  paused_at: string | null;
}

export interface PollMe {
  id: string;
  full_name: string;
  player_code: string;
  username: string;
  submitted_at: string | null;
  correct: number;
  lines: number;
}

export interface BoardCell {
  cell_index: number;
  prompt_id: string | null;
  prompt: string | null;
  is_free: boolean;
  status: "pending" | "confirmed" | null;
  claim_id: string | null;
  coworker_name: string | null;
  last_outcome: "rejected" | "expired" | "revoked" | null;
  last_outcome_name: string | null;
}

export interface IncomingClaim {
  claim_id: string;
  from_name: string;
  prompt: string;
  cell_index: number;
  created_at: string;
}

export interface PollResult {
  correct: number;
  elapsed_seconds: number;
  rank: number | null;
  is_winner: boolean;
  prize_rank: number | null;
  lines: number;
  reach_seconds: number | null;
  host_pick: boolean;
  prize_place: number | null;
}

export interface PollResponse {
  session: PollSession;
  server_now: string;
  me: PollMe;
  board: BoardCell[];
  incoming: IncomingClaim[];
  result: PollResult | null;
}

export interface LeaderboardRow {
  player_id: string;
  full_name: string;
  email: string;
  correct: number;
  elapsed_seconds: number;
  submitted_at: string | null;
  eligible: boolean;
  rank: number | null;
  is_winner: boolean;
  prize_rank: number | null;
  lines: number;
  reach_seconds: number | null;
  /** place given by the host (migration 0018) */
  award_place: number | null;
  /** winner only because the host picked them */
  host_pick: boolean;
  /** automatic winners: position 1..k; host picks: award_place */
  prize_place: number | null;
}

/** Row from the admin_sessions() RPC. */
export type SessionListItem = Pick<
  SessionRow,
  "id" | "code" | "name" | "status" | "duration_seconds" | "started_at" | "ends_at" | "ended_at" | "created_at"
> & { player_count: number; paused_at?: string | null };

export interface ActivityItem {
  id: string;
  cell_index: number;
  player_name: string;
  coworker_name: string;
  prompt: string | null;
  resolved_at: string | null;
}
