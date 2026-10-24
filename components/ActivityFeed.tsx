import type { ActivityItem } from "@/lib/supabase/types";

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) return <p className="p-4 text-slate-500">No confirmations yet.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {items.map((a) => (
        <li key={a.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
          <span className="min-w-0 break-words">
            <span className="font-semibold">{a.player?.full_name ?? "Someone"}</span> met{" "}
            <span className="font-semibold">{a.coworker?.full_name ?? "a coworker"}</span>
          </span>
          <time className="shrink-0 text-xs text-slate-500">
            {new Date(a.resolved_at ?? a.created_at).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
            })}
          </time>
        </li>
      ))}
    </ul>
  );
}
