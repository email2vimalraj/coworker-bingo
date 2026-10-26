import { getSupabase } from "@/lib/supabase/client";
import { ApiError } from "@/lib/errors";
import type { JoinInfo, JoinResult, PollResponse } from "@/lib/supabase/types";

/** Calls a Postgres RPC and throws ApiError (with a parsed `code`) on failure. */
export async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().rpc(name, args);
  if (error) throw new ApiError(error.message || error.code || "unknown");
  return data as T;
}

export const playerApi = {
  joinInfo: (code: string) => rpc<JoinInfo>("session_join_info", { p_code: code }),
  join: (code: string, fullName: string, email: string) =>
    rpc<JoinResult>("join_session", { p_code: code, p_full_name: fullName, p_email: email }),
  poll: (token: string) => rpc<PollResponse>("player_poll", { p_token: token }),
  createClaim: (token: string, cellIndex: number, coworkerCode: string) =>
    rpc<{ claim_id: string; coworker_name: string }>("create_claim", {
      p_token: token,
      p_cell_index: cellIndex,
      p_coworker_code: coworkerCode,
    }),
  respondClaim: (token: string, claimId: string, accept: boolean) =>
    rpc<{ claim_id: string; status: string }>("respond_claim", {
      p_token: token,
      p_claim_id: claimId,
      p_accept: accept,
    }),
  cancelClaim: (token: string, claimId: string) =>
    rpc<unknown>("cancel_claim", { p_token: token, p_claim_id: claimId }),
  submitBoard: (token: string) =>
    rpc<{ submitted_at: string; correct: number }>("submit_board", { p_token: token }),
};
