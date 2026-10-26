"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePlayer } from "@/components/PlayerProvider";
import { RequestPopupToggle } from "@/components/RequestPopupToggle";
import { Button, Card, ErrorBox } from "@/components/ui";
import { friendlyError } from "@/lib/errors";
import { formatClock } from "@/lib/useCountdown";
import type { IncomingClaim } from "@/lib/supabase/types";

const EXPIRY_MS = 2 * 60 * 1000;

export default function RequestsPage() {
  const { sessionCode, data, offset, respond } = usePlayer();
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const rows = data.incoming.filter((c) => !handled.has(c.claim_id));
  const paused = data.session.paused;

  async function answer(c: IncomingClaim, accept: boolean) {
    setBusyId(c.claim_id);
    setError(null);
    try {
      await respond(c.claim_id, accept);
      setHandled((prev) => new Set(prev).add(c.claim_id)); // optimistic; the poll confirms
    } catch (e) {
      setError(friendlyError(e));
      // Already answered / expired: drop it. Other errors (e.g. paused): keep the row.
      const msg = e instanceof Error ? e.message : String(e);
      if (/CLAIM_NOT_PENDING|CLAIM_NOT_FOUND|SESSION_ENDED|TIME_UP/.test(msg)) {
        setHandled((prev) => new Set(prev).add(c.claim_id));
      }
    } finally {
      setBusyId(null);
    }
  }

  function timeLeft(c: IncomingClaim): string | null {
    if (paused) return "Paused";
    const left = EXPIRY_MS - (now + offset - new Date(c.created_at).getTime());
    return left > 0 ? `about ${formatClock(left)} left` : "expiring soon";
  }

  return (
    <main className="mx-auto min-h-dvh w-full max-w-md space-y-3 p-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
      <Link href={`/play/${sessionCode}`} className="inline-flex min-h-11 items-center text-base font-semibold text-accent">
        &larr; Back to board
      </Link>
      <h1 className="text-2xl font-extrabold">Requests</h1>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {rows.length === 0 ? (
        <Card className="text-center text-slate-600">No one is waiting for your answer.</Card>
      ) : (
        <ul className="space-y-3">
          {rows.map((c) => (
            <li key={c.claim_id}>
              <Card className="space-y-2">
                <p className="text-base text-slate-700">
                  <span className="font-bold text-slate-900">{c.from_name}</span> says:
                </p>
                <p className="text-lg font-extrabold leading-tight">&ldquo;{c.prompt}&rdquo;</p>
                <p className="text-sm text-slate-500">True for you? {timeLeft(c)}</p>
                <div className="grid grid-cols-2 gap-3">
                  <Button variant="secondary" disabled={busyId !== null} onClick={() => answer(c, false)}>
                    No
                  </Button>
                  <Button disabled={busyId !== null} onClick={() => answer(c, true)}>
                    Yes
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <RequestPopupToggle />
    </main>
  );
}
