"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { effectiveStatus } from "@/lib/useSessionDashboard";
import type { SessionListItem } from "@/lib/supabase/types";
import { DeleteSessionDialog } from "@/components/DeleteSessionDialog";
import { Button, Card, ErrorBox, Spinner } from "@/components/ui";

const STATUS_STYLE = {
  lobby: "bg-slate-100 text-slate-700",
  live: "bg-emerald-100 text-emerald-800",
  ended: "bg-slate-200 text-slate-600",
} as const;

export default function AdminHome() {
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await getSupabase().rpc("admin_sessions");
    if (err) setError(friendlyError(err));
    else {
      setError(null);
      setSessions(data as unknown as SessionListItem[]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-extrabold">Sessions</h1>
        <Link
          href="/admin/sessions/new"
          className="inline-flex min-h-11 items-center rounded-xl bg-accent px-4 font-semibold text-white hover:bg-accent-dark"
        >
          Create session
        </Link>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {!sessions ? (
        <Spinner />
      ) : sessions.length === 0 ? (
        <Card>No sessions yet. Create your first one!</Card>
      ) : (
        <ul className="space-y-3">
          {sessions.map((s) => {
            const status = effectiveStatus(s);
            return (
              <li key={s.id}>
                <Card className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        href={`/admin/sessions/${s.id}`}
                        className="block break-words text-lg font-bold text-slate-900 hover:text-accent"
                      >
                        {s.name}
                      </Link>
                      <p className="text-sm text-slate-500">
                        <span className="font-mono font-semibold">{s.code}</span> &middot; created{" "}
                        {formatDate(s.created_at)} &middot; {Number(s.player_count)} {Number(s.player_count) === 1 ? "player" : "players"}
                      </p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase ${STATUS_STYLE[status]}`}>
                      {status}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link
                      href={`/admin/sessions/${s.id}`}
                      className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 px-4 font-semibold"
                    >
                      Open
                    </Link>
                    <Button variant="ghost" onClick={() => setDeleting(deleting === s.id ? null : s.id)}>
                      Delete
                    </Button>
                  </div>
                  {deleting === s.id ? (
                    <DeleteSessionDialog
                      sessionId={s.id}
                      sessionName={s.name}
                      onCancel={() => setDeleting(null)}
                      onDeleted={() => {
                        setDeleting(null);
                        void load();
                      }}
                    />
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
