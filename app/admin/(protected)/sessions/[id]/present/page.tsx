"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getAppOrigin } from "@/lib/appUrl";
import { joinUrl } from "@/lib/codes";
import { effectiveStatus, useSessionDashboard } from "@/lib/useSessionDashboard";
import { formatClock, useCountdown } from "@/lib/useCountdown";
import { Leaderboard } from "@/components/Leaderboard";
import { QRCode } from "@/components/QRCode";
import { Spinner } from "@/components/ui";

export default function PresentPage() {
  const { id } = useParams<{ id: string }>();
  const { session, rows, loading } = useSessionDashboard(id);
  const [origin, setOrigin] = useState("");
  const [qrSize, setQrSize] = useState(360);
  const remaining = useCountdown(session?.ends_at ?? null, 0);

  useEffect(() => {
    setOrigin(getAppOrigin());
    const fit = () => setQrSize(Math.max(220, Math.min(520, Math.floor(window.innerHeight * 0.45), Math.floor(window.innerWidth * 0.8))));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  if (loading || !session) return <Spinner />;
  const status = effectiveStatus(session);
  const clock =
    status === "live" && remaining !== null
      ? formatClock(remaining)
      : status === "lobby"
        ? formatClock(session.duration_seconds * 1000)
        : "00:00";

  return (
    <main className="min-h-dvh bg-white p-6">
      <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-2">
        <section className="flex flex-col items-center gap-4 text-center">
          <h1 className="text-3xl font-extrabold lg:text-5xl">{session.name}</h1>
          {origin ? <QRCode value={joinUrl(origin, session.code)} size={qrSize} className="border-4 border-slate-900" /> : null}
          <p className="text-xl font-semibold text-slate-600">Scan to join, or go to {origin.replace(/^https?:\/\//, "")} and enter</p>
          <p className="font-mono text-6xl font-extrabold tracking-[0.2em] lg:text-8xl">{session.code}</p>
        </section>
        <section className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-2xl font-bold uppercase text-slate-500">
              {status === "lobby" ? "Starting soon" : status === "live" ? "Time left" : "Final results"}
            </span>
            <span
              className={`font-mono text-7xl font-extrabold tabular-nums lg:text-9xl ${status === "live" && remaining !== null && remaining <= 60_000 ? "text-red-600" : ""}`}
            >
              {clock}
            </span>
          </div>
          <div className="rounded-2xl border border-slate-200">
            <h2 className="px-4 pt-3 text-2xl font-bold">Top 10 &middot; {rows.length} joined</h2>
            <Leaderboard rows={rows.slice(0, 10)} showEmail={false} big />
          </div>
        </section>
      </div>
    </main>
  );
}
