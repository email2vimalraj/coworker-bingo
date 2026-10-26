"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { rpc } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { friendlyError } from "@/lib/errors";
import {
  barPercent,
  formatPercent,
  formatSeconds,
  highlightPrompts,
  peopleCsv,
  promptsCsv,
  type SessionStats,
} from "@/lib/stats";
import { getSupabase } from "@/lib/supabase/client";
import { Button, Card, ErrorBox, Spinner } from "@/components/ui";

function Tile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 text-center">
      <p className="text-3xl font-extrabold tabular-nums">{value}</p>
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      {sub ? <p className="text-xs text-slate-500">{sub}</p> : null}
    </div>
  );
}

export default function SessionStatsPage() {
  const { id } = useParams<{ id: string }>();
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [name, setName] = useState("session");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, sess] = await Promise.all([
          rpc<SessionStats>("session_stats", { p_session_id: id }),
          getSupabase().from("sessions").select("name, status, ends_at").eq("id", id).maybeSingle(),
        ]);
        if (cancelled) return;
        setStats(s);
        if (sess.data) {
          setName(sess.data.name);
          const over = sess.data.ends_at && new Date(sess.data.ends_at).getTime() < Date.now();
          setStatus(sess.data.status === "live" && over ? "ended" : sess.data.status);
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

  const slug = name.replace(/[^\w-]+/g, "_");
  const back = (
    <Link href={`/admin/sessions/${id}`} className="text-sm font-semibold text-accent">
      &larr; Dashboard
    </Link>
  );

  if (loading) return <Spinner />;
  if (!stats) {
    return (
      <div className="space-y-3">
        {back}
        <ErrorBox>{error ?? "No stats available."}</ErrorBox>
      </div>
    );
  }

  const { participation: p, squares: sq, timing, prompts, people } = stats;
  const marks = highlightPrompts(prompts);
  const maxFound = Math.max(0, ...prompts.map((x) => x.found_count));
  const maxDist = Math.max(0, ...sq.distribution.map((d) => d.players));
  const maxConn = Math.max(0, ...people.top_connected.map((x) => x.connections));

  return (
    <div className="space-y-4">
      <div>
        {back}
        <h1 className="break-words text-2xl font-extrabold">Stats: {name}</h1>
        {status && status !== "ended" ? (
          <p className="mt-1 rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
            Final numbers once the game has ended
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Tile label="Joined" value={p.joined} />
        <Tile label="Active" value={p.active} sub={formatPercent(p.participation_rate)} />
        <Tile label="Submitted" value={p.submitted} />
        <Tile label="Full cards" value={p.full_cards} />
        <Tile label="Connections" value={people.total_unique_connections} sub="unique pairs" />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Confirmed" value={sq.confirmed} />
        <Tile label="Rejected" value={sq.rejected} />
        <Tile label="Avg per player" value={sq.avg_confirmed_per_player} sub={`median ${sq.median_confirmed_per_player}`} />
        <Tile
          label="Avg time"
          value={formatSeconds(timing.avg_elapsed_seconds)}
          sub={`median ${formatSeconds(timing.median_elapsed_seconds)}`}
        />
      </div>
      {timing.fastest_full_card ? (
        <p className="text-sm text-slate-700">
          Fastest full card: <strong>{timing.fastest_full_card.name}</strong> in{" "}
          {formatSeconds(timing.fastest_full_card.seconds)}
        </p>
      ) : null}

      <Card className="space-y-2">
        <h2 className="text-lg font-bold">Confirmed squares per player</h2>
        <ul className="space-y-1.5">
          {sq.distribution.map((d) => (
            <li key={d.label} className="flex items-center gap-2 text-sm">
              <span className="w-12 shrink-0 text-right font-mono text-slate-600">{d.label}</span>
              <div className="h-6 flex-1 rounded bg-slate-100">
                <div className="h-6 rounded bg-accent" style={{ width: `${barPercent(d.players, maxDist)}%` }} />
              </div>
              <span className="w-10 shrink-0 tabular-nums font-semibold">{d.players}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-2">
          <h2 className="text-lg font-bold">Prompts</h2>
          <Button
            variant="secondary"
            disabled={prompts.length === 0}
            onClick={() => downloadCsv(`${slug}-prompt-stats.csv`, promptsCsv(prompts))}
          >
            Download CSV
          </Button>
        </div>
        <p className="px-4 pb-2 text-xs text-slate-500">
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-semibold text-emerald-800">Most found</span>{" "}
          <span className="rounded bg-rose-100 px-1.5 py-0.5 font-semibold text-rose-800">Least found</span>
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Prompt</th>
                <th className="px-2 py-2">Found</th>
                <th className="px-2 py-2">Rejected</th>
                <th className="px-4 py-2">Reject %</th>
              </tr>
            </thead>
            <tbody>
              {prompts.map((r, i) => (
                <tr
                  key={r.prompt_id}
                  className={`border-t border-slate-100 ${marks[i] === "top" ? "bg-emerald-50" : marks[i] === "bottom" ? "bg-rose-50" : ""}`}
                >
                  <td className="min-w-48 px-4 py-2">{r.text}</td>
                  <td className="min-w-28 px-2 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-16 rounded bg-slate-200">
                        <div
                          className={`h-2 rounded ${marks[i] === "bottom" ? "bg-rose-500" : "bg-emerald-500"}`}
                          style={{ width: `${barPercent(r.found_count, maxFound)}%` }}
                        />
                      </div>
                      <span className="tabular-nums font-semibold">{r.found_count}</span>
                    </div>
                  </td>
                  <td className="px-2 py-2 tabular-nums">{r.rejected_count}</td>
                  <td className="px-4 py-2 tabular-nums">{formatPercent(r.rejection_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-2">
          <h2 className="text-lg font-bold">Most connected</h2>
          <Button
            variant="secondary"
            disabled={people.top_connected.length === 0}
            onClick={() => downloadCsv(`${slug}-most-connected.csv`, peopleCsv(people.top_connected))}
          >
            Download CSV
          </Button>
        </div>
        {people.top_connected.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-slate-500">No confirmed connections yet.</p>
        ) : (
          <ol className="divide-y divide-slate-100">
            {people.top_connected.map((x, i) => (
              <li key={`${x.name}-${i}`} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="w-6 shrink-0 text-right font-mono text-slate-500">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{x.name}</p>
                  <div className="mt-1 h-1.5 rounded bg-slate-200">
                    <div className="h-1.5 rounded bg-accent" style={{ width: `${barPercent(x.connections, maxConn)}%` }} />
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-bold tabular-nums">{x.connections} met</p>
                  <p className="text-xs text-slate-500">{x.times_confirmed_for_others} confirmed</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
