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
  const low = ms !== null && ms <= 60_000;
  return (
    <span
      className={`font-mono font-bold tabular-nums ${low ? "text-red-600" : ""} ${className}`}
      aria-label="Time remaining"
    >
      {ms === null ? "--:--" : formatClock(ms)}
    </span>
  );
}
