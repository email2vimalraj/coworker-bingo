"use client";
import { useEffect, useRef } from "react";
import { useCountdown } from "./useCountdown";

const WARN_MS = 60_000;

/**
 * Calls `onWarn` once when the countdown reaches 60s left. Remembered per end time
 * in sessionStorage so re-renders and reloads do not refire it. Never fires while paused
 * (the clock is frozen, but wall time keeps moving towards the stale ends_at).
 */
export function useMinuteWarning(
  endsAt: string | null,
  offset: number,
  onWarn: () => void,
  pausedAt: string | null = null,
): void {
  const ms = useCountdown(endsAt, offset, pausedAt);
  const fired = useRef<string | null>(null);
  const cb = useRef(onWarn);
  useEffect(() => {
    cb.current = onWarn;
  });
  useEffect(() => {
    if (!endsAt || pausedAt || ms === null || ms <= 0 || ms > WARN_MS || fired.current === endsAt) return;
    fired.current = endsAt;
    const key = `bingo-minute-warned:${endsAt}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      /* fall back to the ref only */
    }
    cb.current();
  }, [endsAt, ms, pausedAt]);
}
