"use client";
import { formatClock, useCountdown } from "@/lib/useCountdown";

export function Timer({
  endsAt,
  offset,
  className = "",
}: {
  endsAt: string | null;
  offset: number;
  className?: string;
}) {
  const ms = useCountdown(endsAt, offset);
  const low = ms !== null && ms > 0 && ms <= 60_000;
  const critical = low && ms <= 10_000;
  return (
    <span
      className={`font-mono font-bold tabular-nums ${low ? "timer-warning text-red-600" : ""} ${critical ? "inline-block origin-left scale-125 font-black" : ""} ${className}`}
      aria-label="Time remaining"
    >
      {ms === null ? "--:--" : formatClock(ms)}
    </span>
  );
}
