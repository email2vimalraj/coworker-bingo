"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePlayer } from "@/components/PlayerProvider";
import { BingoBoard } from "@/components/BingoBoard";
import { CellSheet } from "@/components/CellSheet";
import { MyQr } from "@/components/MyQr";
import { notify } from "@/lib/alerts";
import { useMinuteWarning } from "@/lib/useMinuteWarning";
import { SoundToggle } from "@/components/SoundToggle";
import { Timer } from "@/components/Timer";
import { Button, Card, ErrorBox } from "@/components/ui";
import { playerApi } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { formatDuration, useCountdown } from "@/lib/useCountdown";
import { ordinal } from "@/lib/format";
import type { BoardCell } from "@/lib/supabase/types";

export default function PlayPage() {
  const { sessionCode, token, data, offset, refresh } = usePlayer();
  const router = useRouter();
  const { session, me, board, result } = data;
  const remaining = useCountdown(session.ends_at, offset);
  const [selected, setSelected] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);

  useMinuteWarning(session.status === "live" ? session.ends_at : null, offset, () => {
    notify("warning");
    setToast("1 minute left!");
    window.setTimeout(() => setToast(null), 4000);
  });

  const submitted = !!me.submitted_at;
  const timeUp = session.status === "live" && remaining !== null && remaining <= 0;
  const locked = submitted || timeUp || session.status !== "live";

  // Toast when a request is newly rejected / timed out.
  useEffect(() => {
    const keys = board
      .filter((c) => !c.status && c.last_outcome)
      .map((c) => ({
        key: `${c.cell_index}:${c.last_outcome}:${c.last_outcome_name}`,
        msg: c.last_outcome === "rejected" ? `${c.last_outcome_name} said no` : "Request timed out",
      }));
    if (seen.current === null) {
      seen.current = new Set(keys.map((k) => k.key));
      return;
    }
    const fresh = keys.find((k) => !seen.current!.has(k.key));
    keys.forEach((k) => seen.current!.add(k.key));
    if (fresh) {
      setToast(fresh.msg);
      const id = window.setTimeout(() => setToast(null), 4000);
      return () => window.clearTimeout(id);
    }
  }, [board]);

  const selectedCell: BoardCell | undefined = board.find((c) => c.cell_index === selected);

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await playerApi.submitBoard(token);
      setConfirming(false);
    } catch (e) {
      setSubmitError(friendlyError(e));
    } finally {
      await refresh();
      setSubmitting(false);
    }
  }

  const toastEl = toast ? (
    <div
      role="status"
      className="fixed inset-x-0 top-16 z-30 mx-auto w-fit max-w-[90vw] rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-lg"
    >
      {toast}
    </div>
  ) : null;

  if (session.status === "lobby") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 p-4">
        <header className="relative pt-4 text-center">
          <SoundToggle className="absolute right-0 top-0" />
          <p className="text-sm font-semibold uppercase tracking-wide text-accent">{session.name}</p>
          <h1 className="mt-1 text-3xl font-extrabold">Hi {me.full_name.split(" ")[0]}!</h1>
        </header>
        <Card className="text-center">
          <p className="text-xl font-bold">Waiting for host...</p>
          <p className="mt-1 text-slate-600">
            The game starts when the host presses start. This page updates by itself.
          </p>
        </Card>
        <Card>
          <p className="mb-3 text-center font-semibold">Your QR: coworkers scan this to confirm squares</p>
          <MyQr sessionCode={sessionCode} playerCode={me.player_code} />
        </Card>
      </main>
    );
  }

  if (session.status === "ended") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 p-4">
        <header className="pt-4 text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-accent">{session.name}</p>
          <h1 className="mt-1 text-3xl font-extrabold">Game over</h1>
        </header>
        {result?.is_winner ? (
          <div className="rounded-2xl bg-amber-400 p-4 text-center text-amber-950 shadow">
            <p className="text-2xl font-extrabold">You won!</p>
            {result.prize_rank ? (
              <p className="text-lg font-bold">{ordinal(result.prize_rank)} prize</p>
            ) : null}
          </div>
        ) : null}
        <Card>
          <dl className="grid grid-cols-3 gap-2 text-center">
            <div>
              <dt className="text-xs font-semibold uppercase text-slate-500">Correct</dt>
              <dd className="text-3xl font-extrabold">{result?.correct ?? me.correct}/24</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase text-slate-500">Time</dt>
              <dd className="text-3xl font-extrabold tabular-nums">
                {result ? formatDuration(result.elapsed_seconds) : "--:--"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase text-slate-500">Rank</dt>
              <dd className="text-3xl font-extrabold">{result?.rank ? `#${result.rank}` : "-"}</dd>
            </div>
          </dl>
          {result && !result.rank ? (
            <p className="mt-3 text-center text-sm text-slate-600">
              You weren&apos;t ranked this time (this game ranks full cards only).
            </p>
          ) : null}
          {result && !result.is_winner && result.correct === 0 ? (
            <p className="mt-3 text-center text-sm text-slate-600">
              You need at least one confirmed square to be in the running for a prize.
            </p>
          ) : null}
        </Card>
        <BingoBoard board={board} selected={selected} onSelect={(c) => !c.is_free && setSelected(c.cell_index)} />
        {selectedCell ? (
          <CellSheet cell={selectedCell} token={token} locked onClose={() => setSelected(null)} onScan={() => {}} onChanged={refresh} />
        ) : null}
        <p className="pb-6 text-center text-sm text-slate-500">Thanks for playing!</p>
      </main>
    );
  }

  // live
  return (
    <div className="mx-auto min-h-dvh w-full max-w-md">
      <header className="sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-slate-200 bg-white/95 px-3 py-2 backdrop-blur">
        <div>
          <p className="text-[11px] font-semibold uppercase text-slate-500">Time left</p>
          <Timer endsAt={session.ends_at} offset={offset} className="text-2xl" />
        </div>
        <div className="text-center">
          <p className="text-[11px] font-semibold uppercase text-slate-500">Score</p>
          <p className="text-2xl font-extrabold tabular-nums">{me.correct}/24</p>
        </div>
        <SoundToggle />
        <Link
          href={`/play/${sessionCode}/me`}
          className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 px-3 text-sm font-semibold"
        >
          My QR
        </Link>
      </header>
      {toastEl}
      <main className="space-y-3 p-2 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        {submitted ? (
          <div className="rounded-xl bg-indigo-100 p-3 text-center text-sm font-semibold text-indigo-900">
            Board submitted! Waiting for the game to end. Keep confirming coworkers&apos; requests.
          </div>
        ) : timeUp ? (
          <div className="rounded-xl bg-red-100 p-3 text-center text-sm font-semibold text-red-800">
            Time&apos;s up! Your board is locked.
          </div>
        ) : null}
        <BingoBoard
          board={board}
          selected={selected}
          onSelect={(c) => !c.is_free && setSelected(c.cell_index)}
        />
        {!locked ? (
          <div className="space-y-2 px-1">
            {submitError ? <ErrorBox>{submitError}</ErrorBox> : null}
            {confirming ? (
              <Card className="space-y-3 border-accent">
                <p className="font-semibold">
                  Submit your board with {me.correct}/24 squares? You can&apos;t change it afterwards.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="secondary" disabled={submitting} onClick={() => setConfirming(false)}>
                    Keep playing
                  </Button>
                  <Button disabled={submitting} onClick={submit}>
                    {submitting ? "Submitting..." : "Yes, submit"}
                  </Button>
                </div>
              </Card>
            ) : (
              <Button className="w-full" onClick={() => setConfirming(true)}>
                Submit board
              </Button>
            )}
          </div>
        ) : null}
      </main>
      {selectedCell ? (
        <CellSheet
          cell={selectedCell}
          token={token}
          locked={locked}
          onClose={() => setSelected(null)}
          onScan={(i) => router.push(`/play/${sessionCode}/scan?cell=${i}`)}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}
