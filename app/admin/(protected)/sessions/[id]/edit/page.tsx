"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { getSupabase } from "@/lib/supabase/client";
import type { SessionRow } from "@/lib/supabase/types";
import { SessionForm, type SessionFormValues, type SessionPayload } from "@/components/SessionForm";
import { Card, ErrorBox, Spinner } from "@/components/ui";

export default function EditSession() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [session, setSession] = useState<SessionRow | null>(null);
  const [initial, setInitial] = useState<SessionFormValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = getSupabase();
        const [s, p] = await Promise.all([
          sb.from("sessions").select("*").eq("id", id).maybeSingle(),
          sb.from("session_prompts").select("text, position").eq("session_id", id).order("position"),
        ]);
        if (s.error) throw s.error;
        if (p.error) throw p.error;
        if (cancelled) return;
        const row = (s.data as SessionRow | null) ?? null;
        setSession(row);
        if (row) {
          const prompts = Array(24).fill("") as string[];
          for (const r of (p.data ?? []) as { text: string; position: number }[]) prompts[r.position] = r.text;
          setInitial({
            name: row.name,
            minutes: String(Math.ceil(row.duration_seconds / 60)),
            prompts,
            mode: row.ranking_mode,
            fullCard: row.require_full_card,
            winners: String(row.winners_count),
            maxSquares: String(row.max_squares_per_coworker),
            domainsText: (row.allowed_email_domains ?? []).join(", "),
            linesToWin: String(row.lines_to_win ?? 1),
          });
        }
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function save(payload: SessionPayload) {
    await rpc("update_session", { p_session_id: id, ...payload });
    router.push(`/admin/sessions/${id}`);
  }

  if (loading) return <Spinner />;
  if (!session || !initial) {
    return (
      <div className="space-y-3">
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        <p>Session not found.</p>
        <Link href="/admin" className="font-semibold text-accent">
          &larr; All sessions
        </Link>
      </div>
    );
  }
  if (session.status !== "lobby") {
    return (
      <Card className="space-y-3">
        <h1 className="text-2xl font-extrabold">{session.name}</h1>
        <p>This session has already started, so it can no longer be edited.</p>
        <Link href={`/admin/sessions/${id}`} className="font-semibold text-accent">
          &larr; Back to the session
        </Link>
      </Card>
    );
  }
  return (
    <SessionForm
      title="Edit session"
      submitLabel="Save changes"
      busyLabel="Saving..."
      backHref={`/admin/sessions/${id}`}
      backLabel="Back to the session"
      initial={initial}
      onSubmit={save}
    />
  );
}
