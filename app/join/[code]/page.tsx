"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { z } from "zod";
import { playerApi } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { normalizeSessionCode } from "@/lib/codes";
import { loadPlayer, savePlayer } from "@/lib/playerStorage";
import { Button, ErrorBox, Field, inputClass } from "@/components/ui";

const schema = z.object({
  fullName: z.string().trim().min(1, "Please enter your full name.").max(100, "That name is too long."),
  email: z
    .string()
    .trim()
    .min(1, "Please enter your work email.")
    .max(254, "That email is too long.")
    .email("Please enter a valid email address."),
});

export default function JoinPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = normalizeSessionCode(params.code ?? "") ?? (params.code ?? "").toUpperCase();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<{ fullName?: string; email?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [redirecting, setRedirecting] = useState(true);

  useEffect(() => {
    if (loadPlayer(code)) {
      router.replace(`/play/${code}`);
    } else {
      setRedirecting(false);
    }
  }, [code, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = schema.safeParse({ fullName, email });
    if (!parsed.success) {
      const next: { fullName?: string; email?: string } = {};
      for (const issue of parsed.error.issues) {
        const k = issue.path[0] as "fullName" | "email";
        if (!next[k]) next[k] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const res = await playerApi.join(code, parsed.data.fullName, parsed.data.email);
      savePlayer(res.session_code, {
        token: res.player_token,
        playerId: res.player_id,
        playerCode: res.player_code,
      });
      router.replace(`/play/${res.session_code}`);
    } catch (err) {
      setFormError(friendlyError(err));
      setBusy(false);
    }
  }

  if (redirecting) {
    return <main className="flex min-h-dvh items-center justify-center text-slate-500">Loading...</main>;
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-4">
      <header className="text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-accent">Coworker Bingo</p>
        <h1 className="mt-1 text-3xl font-extrabold">Join the game</h1>
        <p className="mt-2 font-mono text-lg font-bold tracking-widest text-slate-600">{code}</p>
      </header>
      <form onSubmit={submit} noValidate className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <Field label="Full name" error={errors.fullName}>
          <input
            className={inputClass}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="name"
            placeholder="Alex Johnson"
            maxLength={100}
          />
        </Field>
        <Field label="Work email" error={errors.email} hint="Used only so you can't join twice.">
          <input
            className={inputClass}
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoCapitalize="none"
            placeholder="alex@company.com"
            maxLength={254}
          />
        </Field>
        {formError ? <ErrorBox>{formError}</ErrorBox> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Joining..." : "Join"}
        </Button>
      </form>
    </main>
  );
}
