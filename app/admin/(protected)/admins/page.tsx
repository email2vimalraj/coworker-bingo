"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { Button, Card, ErrorBox, Field, Spinner, inputClass } from "@/components/ui";

interface AdminRow {
  user_id: string;
  email: string | null;
  added_at: string;
  is_me: boolean;
}

export default function AdminsPage() {
  const [rows, setRows] = useState<AdminRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await rpc<AdminRow[]>("admin_list", {}));
    } catch (e) {
      setError(friendlyError(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await rpc<{ added: boolean }>("admin_add", { p_email: email });
      setNotice(r.added ? `${email.trim()} is now an admin.` : `${email.trim()} is already an admin.`);
      setEmail("");
      await load();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await rpc("admin_remove", { p_user_id: id });
      setConfirmId(null);
      await load();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin" className="text-sm font-semibold text-accent">
          &larr; All sessions
        </Link>
        <h1 className="text-2xl font-extrabold">Admins</h1>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? (
        <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-800">
          {notice}
        </p>
      ) : null}

      <Card className="p-0">
        {rows === null ? (
          <Spinner />
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.user_id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-all font-semibold">
                      {r.email ?? r.user_id}
                      {r.is_me ? <span className="ml-2 rounded-full bg-indigo-100 px-2 py-0.5 text-xs text-indigo-800">you</span> : null}
                    </p>
                    <p className="text-sm text-slate-500">Added {new Date(r.added_at).toLocaleDateString()}</p>
                  </div>
                  {!r.is_me && confirmId !== r.user_id ? (
                    <Button variant="secondary" disabled={busy} onClick={() => setConfirmId(r.user_id)}>
                      Remove
                    </Button>
                  ) : null}
                </div>
                {confirmId === r.user_id ? (
                  <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-3">
                    <p className="text-sm font-medium text-red-900">
                      Remove {r.email ?? "this user"} as an admin? Their account stays, but they lose access.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="danger" disabled={busy} onClick={() => remove(r.user_id)}>
                        Yes, remove
                      </Button>
                      <Button variant="secondary" disabled={busy} onClick={() => setConfirmId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <form onSubmit={add} className="space-y-3">
          <h2 className="text-lg font-bold">Add an admin</h2>
          <Field label="Email" hint="They must first create an account at /admin/login">
            <input
              className={inputClass}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
              required
            />
          </Field>
          <Button type="submit" disabled={busy || !email.trim()}>
            Add admin
          </Button>
        </form>
      </Card>
    </div>
  );
}
