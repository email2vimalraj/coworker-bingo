"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { getAppOrigin } from "@/lib/appUrl";
import { joinUrl } from "@/lib/codes";
import { downloadCsv, leaderboardCsv } from "@/lib/csv";
import { effectiveStatus, useSessionDashboard } from "@/lib/useSessionDashboard";
import { formatClock, useCountdown } from "@/lib/useCountdown";
import { ActivityFeed } from "@/components/ActivityFeed";
import { CopyButton } from "@/components/CopyButton";
import { DeleteSessionDialog } from "@/components/DeleteSessionDialog";
import { Leaderboard } from "@/components/Leaderboard";
import { PlayerAdminSheet } from "@/components/PlayerAdminSheet";
import type { LeaderboardRow } from "@/lib/supabase/types";
import { QRCode } from "@/components/QRCode";
import { Button, Card, ErrorBox, Spinner } from "@/components/ui";

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 text-center">
      <p className="text-3xl font-extrabold tabular-nums">{value}</p>
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
    </div>
  );
}

export default function SessionDashboard() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { session, rows, pending, activity, offsetMs, error, loading, reload } = useSessionDashboard(id);
  const [origin, setOrigin] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [managed, setManaged] = useState<LeaderboardRow | null>(null);
  const remaining = useCountdown(session?.ends_at ?? null, offsetMs);

  useEffect(() => setOrigin(getAppOrigin()), []);

  if (loading) return <Spinner />;
  if (!session) {
    return (
      <div className="space-y-3">
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        <p>Session not found.</p>
        <Link href="/admin" className="font-semibold text-accent">
          &larr; All sessions
        </Link>
      </div>
    );
  }

  const status = effectiveStatus(session, Date.now() + offsetMs);
  const url = origin ? joinUrl(origin, session.code) : "";

  async function action(name: "start_session" | "end_session") {
    setBusy(true);
    setActionError(null);
    try {
      await rpc(name, { p_session_id: id });
      setConfirmEnd(false);
    } catch (e) {
      setActionError(friendlyError(e));
    } finally {
      await reload();
      setBusy(false);
    }
  }

  const joined = rows.length;
  const submitted = rows.filter((r) => r.submitted_at).length;
  const squares = rows.reduce((n, r) => n + r.correct, 0);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin" className="text-sm font-semibold text-accent">
          &larr; All sessions
        </Link>
        <h1 className="break-words text-2xl font-extrabold">{session.name}</h1>
      </div>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {actionError ? <ErrorBox>{actionError}</ErrorBox> : null}

      <div className="grid gap-4 md:grid-cols-[1fr_auto]">
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`rounded-full px-3 py-1 text-sm font-bold uppercase ${
                status === "live"
                  ? "bg-emerald-100 text-emerald-800"
                  : status === "ended"
                    ? "bg-slate-200 text-slate-700"
                    : "bg-amber-100 text-amber-800"
              }`}
            >
              {status === "lobby" ? "Not started" : status}
            </span>
            <span
              className={`font-mono text-5xl font-extrabold tabular-nums ${status === "live" && remaining !== null && remaining <= 60_000 ? "timer-warning text-red-600" : ""}`}
            >
              {status === "live" && remaining !== null
                ? formatClock(remaining)
                : status === "lobby"
                  ? formatClock(session.duration_seconds * 1000)
                  : "00:00"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {status === "lobby" ? (
              <Button disabled={busy} onClick={() => action("start_session")}>
                Start game
              </Button>
            ) : null}
            {status === "live" && !confirmEnd ? (
              <Button variant="secondary" disabled={busy} onClick={() => setConfirmEnd(true)}>
                End early
              </Button>
            ) : null}
            {status === "live" && confirmEnd ? (
              <>
                <Button variant="danger" disabled={busy} onClick={() => action("end_session")}>
                  Yes, end now
                </Button>
                <Button variant="secondary" onClick={() => setConfirmEnd(false)}>
                  Keep running
                </Button>
              </>
            ) : null}
            {status === "ended" && session.status === "live" ? (
              <Button variant="secondary" disabled={busy} onClick={() => action("end_session")}>
                Finalize
              </Button>
            ) : null}
            <Link
              href={`/admin/sessions/${id}/present`}
              target="_blank"
              className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 bg-white px-4 font-semibold"
            >
              Present
            </Link>
            <Link
              href={`/admin/sessions/${id}/stats`}
              className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 bg-white px-4 font-semibold"
            >
              Stats
            </Link>
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
          {confirmDelete ? (
            <DeleteSessionDialog
              sessionId={id}
              sessionName={session.name}
              onCancel={() => setConfirmDelete(false)}
              onDeleted={() => router.replace("/admin")}
            />
          ) : null}
          <p className="text-sm text-slate-600">
            {session.ranking_mode === "full_card_fastest" ? "First full card wins" : "Most squares, then fastest"}
            {session.require_full_card ? ", full card required" : ""} &middot; {session.winners_count} winner
            {session.winners_count === 1 ? "" : "s"} &middot; {session.max_squares_per_coworker} square
            {session.max_squares_per_coworker === 1 ? "" : "s"} per coworker
          </p>
        </Card>

        <Card className="flex flex-col items-center gap-2">
          <p className="text-sm font-semibold text-slate-500">Session code</p>
          <p className="font-mono text-4xl font-extrabold tracking-widest">{session.code}</p>
          {url ? <QRCode value={url} size={180} className="border border-slate-200" /> : null}
          <p className="max-w-[16rem] break-all text-center text-xs text-slate-500">{url}</p>
          <div className="flex gap-2">
            <CopyButton text={session.code} label="Copy code" />
            <CopyButton text={url} label="Copy link" />
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Joined" value={joined} />
        <Stat label="Playing" value={joined - submitted} />
        <Stat label="Submitted" value={submitted} />
        <Stat label="Confirmed squares" value={squares} />
        <Stat label="Pending" value={pending} />
      </div>

      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-0">
          <h2 className="text-lg font-bold">Leaderboard</h2>
          <Button
            variant="secondary"
            disabled={rows.length === 0}
            onClick={() =>
              downloadCsv(`${session.name.replace(/[^\w-]+/g, "_")}-${session.code}-results.csv`, leaderboardCsv(rows))
            }
          >
            Export CSV
          </Button>
        </div>
        <Leaderboard rows={rows} onManage={setManaged} />
        {managed ? (
          <PlayerAdminSheet
            player={managed}
            onClose={() => setManaged(null)}
            onChanged={() => void reload()}
          />
        ) : null}
      </Card>

      <Card className="p-0">
        <h2 className="p-4 pb-1 text-lg font-bold">Latest confirmations</h2>
        <ActivityFeed items={activity} />
      </Card>
    </div>
  );
}
