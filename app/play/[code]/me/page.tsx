"use client";
import Link from "next/link";
import { usePlayer } from "@/components/PlayerProvider";
import { MyQr } from "@/components/MyQr";

export default function MyQrPage() {
  const { sessionCode, data } = usePlayer();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center gap-4 p-4">
      <Link href={`/play/${sessionCode}`} className="mt-2 self-start text-base font-semibold text-accent">
        &larr; Back to board
      </Link>
      <h1 className="text-2xl font-extrabold">{data.me.full_name}</h1>
      <p className="text-center text-slate-600">Let a coworker scan this to confirm one of their squares.</p>
      <MyQr sessionCode={sessionCode} playerCode={data.me.player_code} size={300} big />
    </main>
  );
}
