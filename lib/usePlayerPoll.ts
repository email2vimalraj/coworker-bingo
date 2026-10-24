"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { playerApi } from "@/lib/api";
import { errorCodeOf } from "@/lib/errors";
import type { PollResponse } from "@/lib/supabase/types";
import { intervalFor } from "@/lib/pollInterval";


export interface PollState {
  data: PollResponse | null;
  /** Error code of the latest failed poll (null when the last poll succeeded). */
  errorCode: string | null;
  failed: boolean;
  /** server time minus local time, in ms */
  offset: number;
  refresh: () => Promise<void>;
}

/**
 * Polls player_poll while the game is live and the board isn't submitted:
 * every 1s when `boost` is on (my QR is on screen, so I'm likely being scanned) or when I have a
 * pending claim (waiting for a coworker's answer), otherwise every 3s. Every 3s in the lobby,
 * every 10s after submitting and after the game ends. Pauses while the tab is hidden.
 * `refresh()` fetches immediately.
 */
export function usePlayerPoll(token: string | null, boost = false): PollState {
  const [data, setData] = useState<PollResponse | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [offset, setOffset] = useState(0);
  const dataRef = useRef<PollResponse | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<number | null>(null);
  const schedule = useRef<() => void>(() => {});
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const boostRef = useRef(boost);
  boostRef.current = boost;

  const doPoll = useCallback(async () => {
    const t = tokenRef.current;
    if (!t) return;
    if (inFlight.current) return inFlight.current;
    const p = (async () => {
      const started = Date.now();
      try {
        const res = await playerApi.poll(t);
        const ended = Date.now();
        const mid = (started + ended) / 2;
        setOffset(new Date(res.server_now).getTime() - mid);
        dataRef.current = res;
        setData(res);
        setErrorCode(null);
        setFailed(false);
      } catch (e) {
        setErrorCode(errorCodeOf(e));
        setFailed(true);
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = p;
    return p;
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const clear = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
    const next = () => {
      clear();
      if (cancelled || document.hidden) return;
      const d = dataRef.current;
      timer.current = window.setTimeout(async () => {
        await doPoll();
        next();
      }, intervalFor(d, boostRef.current));
    };
    schedule.current = next;

    const onVisibility = () => {
      if (document.hidden) {
        clear();
      } else {
        void doPoll().then(next);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    void doPoll().then(next);

    return () => {
      cancelled = true;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [token, doPoll]);

  // Switching boost on shouldn't wait out the rest of a 3s or 10s timer.
  useEffect(() => {
    if (boost) schedule.current();
  }, [boost]);

  const refresh = useCallback(async () => {
    // A poll already in flight may predate the action; wait for it, then fetch fresh.
    if (inFlight.current) await inFlight.current;
    await doPoll();
    schedule.current();
  }, [doPoll]);

  return { data, errorCode, failed, offset, refresh };
}
