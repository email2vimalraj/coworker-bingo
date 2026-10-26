import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/SignOutButton";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/admin/login");

  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (!isAdmin) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-4 text-center">
        <h1 className="text-2xl font-extrabold">Your account is not an admin</h1>
        <p className="text-slate-700">
          You&apos;re signed in as <span className="font-semibold">{user.email}</span>, but this
          account isn&apos;t an admin. Ask an existing admin to add{" "}
          <span className="font-semibold">{user.email}</span> on the Admins page.
        </p>
        <div className="flex justify-center">
          <SignOutButton />
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 py-3">
          <Link href="/admin" className="text-lg font-extrabold text-accent">
            Coworker Bingo <span className="text-slate-500">Admin</span>
          </Link>
          <div className="flex items-center gap-1">
            <Link href="/admin/admins" className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-slate-700">
              Admins
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-5xl p-4">{children}</div>
    </div>
  );
}
