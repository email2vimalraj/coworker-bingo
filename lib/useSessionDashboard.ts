"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import type { ActivityItem, LeaderboardRow, SessionRow, SessionStatus } from "@/lib/supabase/types";

export function effectiveStatus(s: Pick<SessionRow, "status" | "ends_at">, nowMs = Date.now()): SessionStatus {
  if (s.status === "live" && s.ends_at && nowMs > new Date(s.ends_at).getTime()) return "ended";
  return s.status;
}

const MIN_GAP_MS = 2000;
const FALLBACK_MS = 10000;

/**
 * Loads a session with its leaderboard, pending count and latest confirmed claims.
 * Realtime (players + claims for this session) triggers refetches throttled to one per 2s;
 * a 10s timer is the fallback.
 */
export function useSessionDashboard(sessionId: string) {
  const [session, setSession] = useState<SessionRow | null>(null);
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [pending, setPending] = useState(0);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastRun = useRef(0);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    lastRun.current = Date.now();
    try {
      const sb = getSupabase();
      const [s, lb, pend, act] = await Promise.all([
        sb.from("sessions").select("*").eq("id", sessionId).maybeSingle(),
        sb.rpc("session_leaderboard", { p_session_id: sessionId }),
        sb
          .from("claims")
          .select("id", { count: "exact", head: true })
          .eq("session_id", sessionId)
          .eq("status", "pending"),
        sb
          .from("claims")
          .select(
            "id, cell_index, resolved_at, created_at, player:players!claims_player_id_fkey(full_name), coworker:players!claims_coworker_id_fkey(full_name)",
          )
          .eq("session_id", sessionId)
          .eq("status", "confirmed")
          .order("resolved_at", { ascending: false })
          .limit(20),
      ]);
      if (s.error) throw s.error;
      if (lb.error) throw lb.error;
      setSession((s.data as SessionRow | null) ?? null);
      setRows((lb.data as LeaderboardRow[] | null) ?? []);
      setPending(pend.count ?? 0);
      setActivity((act.data as unknown as ActivityItem[] | null) ?? []);
      setError(null);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const requestLoad = useCallback(() => {
    if (timer.current !== null) return;
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastRun.current));
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void load();
    }, wait);
  }, [load]);

  useEffect(() => {
    void load();
    const sb = getSupabase();
    const channel = sb
      .channel(`session-${sessionId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "players", filter: `session_id=eq.${sessionId}` },
        requestLoad,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "claims", filter: `session_id=eq.${sessionId}` },
        requestLoad,
      )
      .subscribe();
    const fallback = window.setInterval(() => void load(), FALLBACK_MS);
    return () => {
      window.clearInterval(fallback);
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      void sb.removeChannel(channel);
    };
  }, [sessionId, load, requestLoad]);

  return { session, rows, pending, activity, error, loading, reload: load };
}
