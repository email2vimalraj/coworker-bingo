"use client";
import Link from "next/link";

/** "Requests" button with a count badge; renders nothing when no one is waiting. */
export function RequestsLink({ sessionCode, count }: { sessionCode: string; count: number }) {
  if (count <= 0) return null;
  return (
    <Link
      href={`/play/${sessionCode}/requests`}
      className="flex min-h-11 items-center justify-between rounded-xl bg-amber-100 px-4 font-semibold text-amber-900"
    >
      <span>Requests waiting for you</span>
      <span aria-label={`${count} pending`} className="inline-flex min-w-7 items-center justify-center rounded-full bg-amber-500 px-2 py-0.5 text-sm font-extrabold text-white">
        {count}
      </span>
    </Link>
  );
}
