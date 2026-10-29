"use client";
import { useState } from "react";
import { Podium, revealOrder, sortWinners } from "@/components/Podium";
import { burst } from "@/lib/confetti";
import { ordinal } from "@/lib/format";
import type { LeaderboardRow } from "@/lib/supabase/types";

/** Projector celebration shown once the session has ended. */
export function Celebration({ sessionName, rows }: { sessionName: string; rows: LeaderboardRow[] }) {
  const winners = sortWinners(rows);
  const total = winners.length;
  const [revealed, setRevealed] = useState(0);
  const order = revealOrder(winners);

  function revealNext() {
    if (revealed >= total) return;
    const next = revealed + 1;
    setRevealed(next);
    void burst(next === total ? "finale" : "big");
  }

  function showAll() {
    if (revealed >= total) return;
    setRevealed(total);
    void burst("finale");
  }

  const nextRow = order[revealed];
  return (
    <main className="flex min-h-dvh flex-col items-center gap-[3vmin] bg-slate-950 p-[3vmin] text-center text-white">
      <header>
        <h1 className="text-[clamp(2.5rem,10vmin,9rem)] font-black leading-none text-amber-300">Congratulations!</h1>
        <p className="mt-[1vmin] truncate text-[clamp(1.25rem,3.5vmin,3rem)] font-bold text-slate-300">{sessionName}</p>
      </header>
      <div className="flex w-full flex-1 flex-col items-center justify-center">
        {total === 0 ? (
          <p className="animate-pulse text-[clamp(2rem,7vmin,6rem)] font-extrabold text-slate-300">
            Winners coming up&hellip;
          </p>
        ) : (
          <Podium winners={winners} revealed={revealed} />
        )}
      </div>
      {total > 0 && revealed < total ? (
        <div className="flex flex-wrap items-center justify-center gap-3 pb-2">
          <button
            type="button"
            onClick={revealNext}
            className="min-h-11 rounded-xl bg-amber-400 px-6 text-lg font-bold text-amber-950 hover:bg-amber-300"
          >
            {revealed === 0 ? "Reveal winners" : `Reveal ${ordinal(nextRow?.prize_place ?? total - revealed)} place`}
          </button>
          <button
            type="button"
            onClick={showAll}
            className="min-h-11 rounded-xl border border-slate-600 px-4 text-base font-semibold text-slate-300 hover:bg-slate-800"
          >
            Show all
          </button>
        </div>
      ) : null}
    </main>
  );
}
