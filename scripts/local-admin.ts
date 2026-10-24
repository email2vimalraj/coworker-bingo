/**
 * Creates (or reuses) an admin login on the LOCAL Supabase only.
 *
 *   npm run local:admin                       -> admin@local.test / admin12345
 *   npm run local:admin -- me@work.com pass123
 *
 * Re-run it after `npm run db:reset`, which wipes users.
 */
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const email = process.argv[2] ?? "admin@local.test";
const password = process.argv[3] ?? "admin12345";

const status = JSON.parse(execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as {
  API_URL: string;
  SERVICE_ROLE_KEY: string;
};
if (!/127\.0\.0\.1|localhost/.test(status.API_URL)) {
  console.error(`Refusing to run: ${status.API_URL} is not a local Supabase.`);
  process.exit(1);
}

const sb = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function main() {
  const created = await sb.auth.admin.createUser({ email, password, email_confirm: true });
  let userId = created.data.user?.id;
  if (!userId) {
    const { data } = await sb.auth.admin.listUsers();
    userId = data.users.find((u) => u.email === email)?.id;
  }
  if (!userId) throw new Error(created.error?.message ?? "Could not create user");

  const { error } = await sb.from("admins").upsert({ user_id: userId });
  if (error) throw new Error(error.message);
  console.log(`Local admin ready: ${email} / ${password}  ->  http://localhost:3000/admin/login`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
