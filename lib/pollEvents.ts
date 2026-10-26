import type { BoardCell, IncomingClaim } from "./supabase/types";

export interface PollSnapshot {
  board: Pick<BoardCell, "cell_index" | "status" | "last_outcome">[];
  incoming: Pick<IncomingClaim, "claim_id">[];
}

export interface PollEvents {
  /** claim_ids of incoming requests not seen in any earlier poll. */
  newIncoming: string[];
  /** My cells that went pending -> confirmed. */
  confirmed: number[];
  /** My cells that went pending -> cleared with a rejected/expired outcome. */
  rejected: number[];
}

/**
 * What changed between two polls. `seen` holds every incoming claim_id already
 * reported, so a request that stays in the list is not announced again.
 */
export function diffPolls(prev: PollSnapshot, next: PollSnapshot, seen: ReadonlySet<string>): PollEvents {
  const prevByCell = new Map(prev.board.map((c) => [c.cell_index, c]));
  const confirmed: number[] = [];
  const rejected: number[] = [];
  for (const c of next.board) {
    const before = prevByCell.get(c.cell_index);
    if (before?.status !== "pending") continue;
    if (c.status === "confirmed") confirmed.push(c.cell_index);
    else if (!c.status && (c.last_outcome === "rejected" || c.last_outcome === "expired")) rejected.push(c.cell_index);
  }
  const newIncoming = next.incoming.map((i) => i.claim_id).filter((id) => !seen.has(id));
  return { newIncoming, confirmed, rejected };
}
