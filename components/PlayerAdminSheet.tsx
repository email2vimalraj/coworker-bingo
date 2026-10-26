"use client";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { LeaderboardRow } from "@/lib/supabase/types";
import { Button, ErrorBox, Spinner } from "@/components/ui";

interface Square {
  claim_id: string;
  cell_index: number;
  prompt: string | null;
  coworker_name: string;
  resolved_at: string | null;
}

/** Admin bottom sheet for one player: list/undo confirmed squares, remove the player. */
export function PlayerAdminSheet({
  player,
  onClose,
  onChanged,
}: {
  player: LeaderboardRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [squares, setSquares] = useState<Square[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [undoId, setUndoId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [lost, setLost] = useState<number | null>(null);

  const loadSquares = useCallback(async () => {
    try {
      setSquares(await rpc<Square[]>("admin_player_squares", { p_player_id: player.player_id }));
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [player.player_id]);

  useEffect(() => {
    void loadSquares();
  }, [loadSquares]);

  async function undo(claimId: string) {
    setBusy(true);
    setError(null);
    try {
      await rpc("admin_revoke_claim", { p_claim_id: claimId });
      setUndoId(null);
      await loadSquares();
      onChanged();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function startRemove() {
    setError(null);
    setBusy(true);
    try {
      setLost(await rpc<number>("admin_player_impact", { p_player_id: player.player_id }));
      setRemoving(true);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await rpc<{ removed: boolean; squares_lost_by_others: number }>("admin_remove_player", {
        p_player_id: player.player_id,
      });
      onChanged();
      onClose();
    } catch (e) {
      setError(friendlyError(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-900/50 sm:items-center" role="dialog" aria-modal="true">
      <div className="mx-auto max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-xl font-extrabold">{player.full_name}</h2>
            <p className="break-all text-sm text-slate-600">{player.email}</p>
          </div>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>

        {error ? <ErrorBox>{error}</ErrorBox> : null}

        <h3 className="mt-3 text-sm font-bold uppercase text-slate-500">Confirmed squares</h3>
        {squares === null ? (
          <Spinner />
        ) : squares.length === 0 ? (
          <p className="py-3 text-slate-600">No confirmed squares.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {squares.map((s) => (
              <li key={s.claim_id} className="space-y-2 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words font-semibold">{s.prompt ?? `Square ${s.cell_index + 1}`}</p>
                    <p className="text-sm text-slate-600">Confirmed by {s.coworker_name}</p>
                  </div>
                  {undoId !== s.claim_id ? (
                    <Button variant="secondary" disabled={busy} onClick={() => setUndoId(s.claim_id)}>
                      Undo
                    </Button>
                  ) : null}
                </div>
                {undoId === s.claim_id ? (
                  <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-3">
                    <p className="text-sm font-medium text-red-900">
                      Remove this square from {player.full_name}&apos;s score? The cell reopens on their board.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="danger" disabled={busy} onClick={() => undo(s.claim_id)}>
                        {busy ? "Undoing..." : "Yes, undo square"}
                      </Button>
                      <Button variant="secondary" disabled={busy} onClick={() => setUndoId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 border-t border-slate-200 pt-4">
          {!removing ? (
            <Button variant="danger" disabled={busy} onClick={startRemove}>
              Remove player
            </Button>
          ) : (
            <div className="space-y-2 rounded-xl border-2 border-red-300 bg-red-50 p-3">
              <p className="font-semibold text-red-900">
                Remove {player.full_name} from this session? Their board and squares are deleted.
                {lost ? ` Also removes ${lost} square${lost === 1 ? "" : "s"} this person confirmed for others.` : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" disabled={busy} onClick={remove}>
                  {busy ? "Removing..." : "Yes, remove player"}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => setRemoving(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
