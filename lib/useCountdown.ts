"use client";
import { useEffect, useState } from "react";

/**
 * Milliseconds remaining until `endsAt` (ISO string), corrected by `offsetMs`
 * (server time minus local time). Ticks every 250ms. Returns null without an end time.
 * With `pausedAt` the value is frozen (the server leaves ends_at untouched while paused).
 */
export function useCountdown(
  endsAt: string | null | undefined,
  offsetMs: number,
  /** while paused the clock is frozen at endsAt - pausedAt */
  pausedAt?: string | null,
): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!endsAt) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [endsAt]);
  if (!endsAt) return null;
  if (pausedAt) return Math.max(0, new Date(endsAt).getTime() - new Date(pausedAt).getTime());
  return Math.max(0, new Date(endsAt).getTime() - (now + offsetMs));
}

export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
