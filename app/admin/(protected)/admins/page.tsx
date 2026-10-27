"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { rpc } from "@/lib/api";
import { getSupabase } from "@/lib/supabase/client";
import { errorCodeOf, friendlyError } from "@/lib/errors";
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
  const [password, setPassword] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwNotice, setPwNotice] = useState<string | null>(null);
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
    const shown = email.trim();
    try {
      const r = await rpc<{ created: boolean; added: boolean }>("admin_create", {
        p_email: email,
        p_password: password.trim() ? password : null,
      });
      setNotice(
        r.created
          ? `Account created for ${shown}. They can sign in at /admin/login with the temporary password.`
          : r.added
            ? `${shown} is now an admin.`
            : `${shown} is already an admin.`,
      );
      setEmail("");
      setPassword("");
      await load();
    } catch (err) {
      if (errorCodeOf(err) === "PASSWORD_REQUIRED") {
        setError("No account exists for that email yet — set a temporary password.");
        passwordRef.current?.focus();
      } else setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwNotice(null);
    if (newPw !== newPw2) {
      setPwError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    const { error: upErr } = await getSupabase().auth.updateUser({ password: newPw });
    setBusy(false);
    if (upErr) {
      setPwError(upErr.message || "Couldn't change the password.");
      return;
    }
    setPwNotice("Password changed.");
    setNewPw("");
    setNewPw2("");
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
      if (errorCodeOf(err) === "USER_NOT_FOUND") {
        // Someone else already removed them: refresh the list instead of showing the add-admin wording.
        setConfirmId(null);
        setError("That person is no longer an admin.");
        await load();
      } else setError(friendlyError(err));
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
          <Field label="Email">
            <input
              className={inputClass}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
              required
            />
          </Field>
          <Field
            label="Temporary password (optional)"
            hint="Needed only if they don't have an account yet. Share it with them privately; they can change it after signing in."
          >
            <input
              ref={passwordRef}
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
            />
          </Field>
          <Button type="submit" disabled={busy || !email.trim()}>
            Add admin
          </Button>
        </form>
      </Card>

      <Card>
        <form onSubmit={changePassword} className="space-y-3">
          <h2 className="text-lg font-bold">Change my password</h2>
          <Field label="New password">
            <input
              className={inputClass}
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          <Field label="Confirm new password">
            <input
              className={inputClass}
              type="password"
              value={newPw2}
              onChange={(e) => setNewPw2(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          {pwError ? <ErrorBox>{pwError}</ErrorBox> : null}
          {pwNotice ? (
            <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-800">
              {pwNotice}
            </p>
          ) : null}
          <Button type="submit" disabled={busy || !newPw}>
            Change password
          </Button>
        </form>
      </Card>
    </div>
  );
}
