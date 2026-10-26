"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { usePlayer } from "@/components/PlayerProvider";
import { Scanner } from "@/components/Scanner";
import { CodeEntry } from "@/components/CodeEntry";
import { Button, Card, ErrorBox, Spinner } from "@/components/ui";
import { playerApi } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import type { BoardCell } from "@/lib/supabase/types";

function parseCell(v: string | null): number | null {
  if (v === null || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= 0 && n <= 24 && n !== 12 ? n : null;
}

function ScanInner() {
  const { sessionCode, token, data, refresh } = usePlayer();
  const router = useRouter();
  const sp = useSearchParams();
  const cell = parseCell(sp.get("cell"));
  const presetCode = sp.get("c");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cooldown = useRef<{ text: string; at: number } | null>(null);
  const autoRan = useRef(false);

  const back = `/play/${sessionCode}`;
  const { session, me, board } = data;
  const canPlay = session.status === "live" && !me.submitted_at;

  const claim = useCallback(
    async (cellIndex: number, raw: string) => {
      setBusy(true);
      setError(null);
      try {
        await playerApi.createClaim(token, cellIndex, raw);
        await refresh();
        router.replace(back);
      } catch (e) {
        setError(friendlyError(e));
        void refresh();
        setBusy(false);
      }
    },
    [token, refresh, router, back],
  );

  // A phone camera opened ?c=CODE&cell=N: send straight away.
  useEffect(() => {
    if (presetCode && cell !== null && canPlay && !autoRan.current) {
      autoRan.current = true;
      void claim(cell, presetCode);
    }
  }, [presetCode, cell, canPlay, claim]);

  function onScan(text: string) {
    if (cell === null || busy) return;
    const now = Date.now();
    if (cooldown.current && cooldown.current.text === text && now - cooldown.current.at < 3000) return;
    cooldown.current = { text, at: now };
    void claim(cell, text);
  }

  if (!canPlay) {
    return (
      <Shell back={back}>
        <Card>
          <p className="font-semibold">
            {me.submitted_at
              ? "You've already submitted your board."
              : session.status === "lobby"
                ? "The game hasn't started yet."
                : "The game is over."}
          </p>
        </Card>
      </Shell>
    );
  }

  // Cell known: scanner + manual entry.
  if (cell !== null) {
    const target = board.find((c) => c.cell_index === cell);
    return (
      <Shell back={back}>
        {target ? (
          <Card className="mb-3">
            <p className="text-sm font-semibold text-slate-500">Find someone who...</p>
            <p className="text-xl font-extrabold">{target.prompt}</p>
          </Card>
        ) : null}
        {error ? <div className="mb-3"><ErrorBox>{error}</ErrorBox></div> : null}
        {presetCode && busy ? (
          <Spinner label="Sending request..." />
        ) : (
          <div className="space-y-4">
            <Scanner onResult={onScan} paused={busy} />
            <CodeEntry onSubmit={(raw) => claim(cell, raw)} busy={busy} allowUsername={session.allow_username_claims !== false} />
          </div>
        )}
      </Shell>
    );
  }

  // No cell: let the player pick which open square this coworker fits.
  const open = board.filter((c) => !c.is_free && !c.status);
  return (
    <Shell back={back}>
      <h1 className="mb-1 text-2xl font-extrabold">
        {presetCode ? "Which square fits this coworker?" : "Pick a square first"}
      </h1>
      <p className="mb-3 text-slate-600">
        {presetCode
          ? "Choose the prompt you think is true for the person you just scanned."
          : "Choose an open square, then scan your coworker."}
      </p>
      {error ? <div className="mb-3"><ErrorBox>{error}</ErrorBox></div> : null}
      {open.length === 0 ? (
        <Card>No open squares left.</Card>
      ) : (
        <ul className="space-y-2">
          {open.map((c) => (
            <li key={c.cell_index}>
              <PickButton
                cell={c}
                disabled={busy}
                onClick={() =>
                  presetCode
                    ? claim(c.cell_index, presetCode)
                    : router.push(`/play/${sessionCode}/scan?cell=${c.cell_index}`)
                }
              />
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function PickButton({ cell, disabled, onClick }: { cell: BoardCell; disabled: boolean; onClick: () => void }) {
  return (
    <Button variant="secondary" className="w-full justify-start text-left" disabled={disabled} onClick={onClick}>
      {cell.prompt}
    </Button>
  );
}

function Shell({ back, children }: { back: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-md p-4">
      <Link href={back} className="mb-3 inline-flex min-h-11 items-center text-base font-semibold text-accent">
        &larr; Back to board
      </Link>
      {children}
    </main>
  );
}

export default function ScanPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ScanInner />
    </Suspense>
  );
}
