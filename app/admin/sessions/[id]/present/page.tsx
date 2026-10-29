"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getAppOrigin } from "@/lib/appUrl";
import { joinUrl } from "@/lib/codes";
import { effectiveStatus, useSessionDashboard } from "@/lib/useSessionDashboard";
import { formatClock, formatDuration, useCountdown } from "@/lib/useCountdown";
import { isRevealed } from "@/lib/results";
import { Celebration } from "@/components/Celebration";
import { QRCode } from "@/components/QRCode";
import { Spinner } from "@/components/ui";

/** Full-screen projector view, sized to be readable from across a room. */
export default function PresentPage() {
  const { id } = useParams<{ id: string }>();
  const { session, rows, offsetMs, loading } = useSessionDashboard(id);
  const [origin, setOrigin] = useState("");
  const [qrSize, setQrSize] = useState(400);
  const remaining = useCountdown(session?.ends_at ?? null, offsetMs, session?.paused_at ?? null);

  useEffect(() => {
    setOrigin(getAppOrigin());
    const fit = () =>
      setQrSize(
        Math.max(200, Math.min(720, Math.floor(window.innerHeight * 0.55), Math.floor(window.innerWidth * 0.42))),
      );
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  if (loading || !session) return <Spinner />;
  const status = effectiveStatus(session, Date.now() + offsetMs);
  if (status === "ended" && isRevealed(session)) return <Celebration sessionName={session.name} rows={rows} />;
  if (status === "ended") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-[4vmin] bg-slate-950 p-[3vmin] text-center text-white">
        <p className="truncate text-[clamp(1.25rem,3.5vmin,3rem)] font-bold text-slate-300">{session.name}</p>
        <h1 className="text-[clamp(3rem,16vmin,14rem)] font-black leading-none text-amber-300">Time&apos;s up!</h1>
        <div className="grid w-full max-w-[120vmin] grid-cols-2 gap-[3vmin]">
          <PresentStat label="Players" value={rows.length} />
          <PresentStat label="Squares confirmed" value={rows.reduce((n, r) => n + r.correct, 0)} />
        </div>
        <p className="text-[clamp(1.5rem,5vmin,4.5rem)] font-bold">Winners coming up&hellip;</p>
      </main>
    );
  }
  const clock =
    status === "live" && remaining !== null
      ? formatClock(remaining)
      : status === "lobby"
        ? formatClock(session.duration_seconds * 1000)
        : "00:00";
  const paused = status === "live" && !!session.paused_at;
  const urgent = status === "live" && !paused && remaining !== null && remaining <= 60_000;
  const host = origin.replace(/^https?:\/\//, "");

  return (
    <main className="flex min-h-dvh flex-col gap-[2vmin] bg-slate-950 p-[2.5vmin] text-white">
      <header className="flex items-baseline justify-between gap-[3vmin]">
        <h1 className="min-w-0 truncate text-[clamp(1.5rem,4.5vmin,4rem)] font-extrabold">{session.name}</h1>
        <span className="shrink-0 text-[clamp(1rem,3vmin,2.5rem)] font-bold uppercase tracking-wide text-slate-400">
          {status === "lobby" ? "Starting soon" : paused ? "Paused" : status === "live" ? "Time left" : "Final results"}
        </span>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-[3vmin] landscape:grid-cols-[auto_1fr]">
        <section className="flex flex-col items-center justify-center gap-[2vmin] text-center">
          {origin ? (
            <QRCode value={joinUrl(origin, session.code)} size={qrSize} className="!p-[1.5vmin]" />
          ) : null}
          <p className="text-[clamp(1rem,3vmin,2.5rem)] font-semibold text-slate-300">
            Scan to join, or go to <span className="text-white">{host}</span> and enter
          </p>
          <p className="font-mono text-[clamp(3rem,12vmin,10rem)] font-extrabold leading-none tracking-[0.15em]">
            {session.code}
          </p>
        </section>

        <section className="flex min-w-0 flex-col gap-[2vmin]">
          <p
            className={`text-center font-mono text-[clamp(4rem,20vmin,18rem)] font-extrabold leading-none tabular-nums ${urgent ? "timer-warning text-red-400" : ""} ${paused ? "text-amber-300" : ""}`}
          >
            {clock}
          </p>
          {session.present_show_leaderboard === true ? (
            <div className="min-h-0 flex-1 rounded-3xl bg-slate-900 p-[2vmin]">
              <h2 className="mb-[1vmin] text-[clamp(1.25rem,3.5vmin,3rem)] font-bold">
                Top 10 <span className="text-slate-400">&middot; {rows.length} joined</span>
              </h2>
              <ol className="space-y-[0.6vmin]">
                {rows.slice(0, 10).map((r, i) => (
                  <li
                    key={r.player_id}
                    className={`flex items-center gap-[2vmin] rounded-xl px-[1.5vmin] py-[0.6vmin] text-[clamp(1.1rem,3.2vmin,2.75rem)] ${r.is_winner ? "bg-amber-400/20 font-bold text-amber-200" : ""}`}
                  >
                    <span className="w-[2.2em] shrink-0 tabular-nums text-slate-400">{r.rank ?? i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{r.full_name}</span>
                    <span className="shrink-0 tabular-nums">
                      {session.ranking_mode === "lines"
                        ? `${r.lines} ${r.lines === 1 ? "line" : "lines"}`
                        : `${r.correct}/24`}
                    </span>
                    <span className="w-[3.6em] shrink-0 text-right font-mono tabular-nums text-slate-400">
                      {formatDuration(r.reach_seconds ?? r.elapsed_seconds)}
                    </span>
                  </li>
                ))}
                {rows.length === 0 ? <li className="text-slate-400">Waiting for players to join...</li> : null}
              </ol>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[3vmin] rounded-3xl bg-slate-900 p-[3vmin] text-center">
              <div className="grid w-full grid-cols-2 gap-[3vmin]">
                <PresentStat label="Players" value={rows.length} />
                <PresentStat label="Squares confirmed" value={rows.reduce((n, r) => n + r.correct, 0)} />
              </div>
              <p className="text-[clamp(1.25rem,4vmin,3.5rem)] font-bold text-amber-300">
                {status === "lobby" ? "Get ready to meet your coworkers!" : "Winners revealed when time is up"}
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function PresentStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl bg-slate-800 p-[2vmin]">
      <p className="font-mono text-[clamp(2.5rem,10vmin,8rem)] font-extrabold leading-none tabular-nums">
        {value.toLocaleString()}
      </p>
      <p className="mt-[1vmin] text-[clamp(1rem,3vmin,2.5rem)] font-semibold text-slate-400">{label}</p>
    </div>
  );
}
