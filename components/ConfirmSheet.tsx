"use client";
import { useState } from "react";
import { friendlyError } from "@/lib/errors";
import type { IncomingClaim } from "@/lib/supabase/types";
import { Button } from "@/components/ui";

/** Queued bottom sheet: "FROM says: PROMPT. True for you?" Yes / No. */
export function ConfirmSheet({
  incoming,
  onRespond,
}: {
  incoming: IncomingClaim[];
  onRespond: (claimId: string, accept: boolean) => Promise<void>;
}) {
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queue = incoming.filter((c) => !handled.has(c.claim_id));
  const current = queue[0];
  if (!current) return null;

  async function answer(accept: boolean) {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      await onRespond(current.claim_id, accept);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      // Hide it locally either way; the next poll is the source of truth.
      setHandled((prev) => new Set(prev).add(current.claim_id));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-900/50" role="dialog" aria-modal="true">
      <div className="animate-sheet-up mx-auto w-full max-w-md rounded-t-3xl bg-white p-5 pb-[max(2rem,env(safe-area-inset-bottom))] shadow-2xl">
        {queue.length > 1 ? (
          <p className="mb-2 text-sm font-semibold text-accent">{queue.length - 1} more waiting</p>
        ) : null}
        <p className="text-lg text-slate-700">
          <span className="font-bold text-slate-900">{current.from_name}</span> says:
        </p>
        <p className="my-2 text-2xl font-extrabold leading-tight text-slate-900">
          &ldquo;{current.prompt}&rdquo;
        </p>
        <p className="mb-4 text-lg text-slate-700">True for you?</p>
        {error ? <p className="mb-3 text-sm font-medium text-red-600">{error}</p> : null}
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" className="min-h-14 text-lg" disabled={busy} onClick={() => answer(false)}>
            No
          </Button>
          <Button className="min-h-14 text-lg" disabled={busy} onClick={() => answer(true)}>
            Yes
          </Button>
        </div>
      </div>
    </div>
  );
}
