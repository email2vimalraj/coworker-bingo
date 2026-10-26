"use client";
import { useState } from "react";
import { playerApi } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { BoardCell } from "@/lib/supabase/types";
import { Button, ErrorBox } from "@/components/ui";
import { CodeEntry } from "@/components/CodeEntry";

/** Bottom sheet for one board cell: full prompt plus scan / enter code / cancel actions. */
export function CellSheet({
  cell,
  token,
  locked,
  onClose,
  onScan,
  onChanged,
  allowUsername = true,
}: {
  cell: BoardCell;
  token: string;
  locked: boolean;
  onClose: () => void;
  onScan: (cellIndex: number) => void;
  onChanged: () => Promise<void>;
  allowUsername?: boolean;
}) {
  const [enterCode, setEnterCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitCode(raw: string) {
    setBusy(true);
    setError(null);
    try {
      await playerApi.createClaim(token, cell.cell_index, raw);
      await onChanged();
      onClose();
    } catch (e) {
      setError(friendlyError(e));
      void onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!cell.claim_id) return;
    setBusy(true);
    setError(null);
    try {
      await playerApi.cancelClaim(token, cell.claim_id);
      await onChanged();
      onClose();
    } catch (e) {
      setError(friendlyError(e));
      void onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-end bg-slate-900/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="animate-sheet-up mx-auto max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(2rem,env(safe-area-inset-bottom))] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-semibold text-slate-500">Find someone who...</p>
        <h2 className="mb-3 text-2xl font-extrabold leading-tight text-slate-900">{cell.prompt}</h2>

        {cell.status === "confirmed" ? (
          <p className="mb-3 rounded-xl bg-emerald-100 p-3 font-semibold text-emerald-900">
            Confirmed by {cell.coworker_name}
          </p>
        ) : null}
        {cell.status === "pending" ? (
          <p className="mb-3 rounded-xl bg-amber-100 p-3 font-semibold text-amber-900">
            Waiting for {cell.coworker_name} to confirm...
          </p>
        ) : null}
        {!cell.status && cell.last_outcome ? (
          <p className="mb-3 rounded-xl bg-red-50 p-3 font-semibold text-red-700">
            {cell.last_outcome === "rejected"
              ? `${cell.last_outcome_name} said no. Try someone else!`
              : cell.last_outcome === "revoked"
                ? "Removed by host. You can pick this square again."
                : "That request timed out. Try again!"}
          </p>
        ) : null}
        {error ? <div className="mb-3"><ErrorBox>{error}</ErrorBox></div> : null}

        <div className="space-y-3">
          {!cell.status && !locked ? (
            <>
              <Button className="w-full" onClick={() => onScan(cell.cell_index)}>
                Scan coworker
              </Button>
              {enterCode ? (
                <CodeEntry onSubmit={submitCode} busy={busy} allowUsername={allowUsername} />
              ) : (
                <Button variant="secondary" className="w-full" onClick={() => setEnterCode(true)}>
                  {allowUsername ? "Code or username" : "Code"}
                </Button>
              )}
            </>
          ) : null}
          {cell.status === "pending" && !locked ? (
            <Button variant="danger" className="w-full" disabled={busy} onClick={cancel}>
              Cancel request
            </Button>
          ) : null}
          {locked && !cell.status ? (
            <p className="text-sm text-slate-500">Your board is locked.</p>
          ) : null}
          <Button variant="ghost" className="w-full" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
