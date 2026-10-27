/**
 * End-to-end check against a running LOCAL Supabase (`npx supabase start`).
 * Exercises the real API: admin auth, every RPC, RLS and admin realtime events.
 *
 *   npm run e2e:local
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_PROMPTS } from "../lib/defaultPrompts";

function env(...names: string[]): string {
  for (const name of names) {
    if (process.env[name]) return process.env[name] as string;
    const line = readFileSync(".env.local", "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${name}=`));
    if (line && line.slice(name.length + 1).trim()) return line.slice(name.length + 1).trim();
  }
  throw new Error(`Missing ${names.join(" or ")} (set it or add it to .env.local)`);
}

const URL = env("NEXT_PUBLIC_SUPABASE_URL");
const ANON = env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY");
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@local.test";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "admin12345";

if (!/127\.0\.0\.1|localhost/.test(URL)) {
  console.error(`Refusing to run: ${URL} is not a local Supabase.`);
  process.exit(1);
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${!ok && detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const newClient = () => createClient(URL, ANON, { auth: { persistSession: false } });

async function rpc<T>(c: SupabaseClient, name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await c.rpc(name, args);
  return { data: data as T, error: error?.message ?? null };
}

type Cell = { cell_index: number; is_free: boolean; status: string | null; claim_id: string | null; last_outcome: string | null };
type Poll = {
  session: { status: string };
  me: { player_code: string; username: string; correct: number; submitted_at: string | null };
  board: Cell[];
  incoming: { claim_id: string; from_name: string; prompt: string }[];
  result: null | { correct: number; rank: number | null; is_winner: boolean; prize_rank: number | null };
};

async function main() {
  // ---- Admin ----
  const admin = newClient();
  const { error: signInErr } = await admin.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  check("admin signs in", !signInErr, signInErr?.message);
  const isAdmin = await rpc<boolean>(admin, "is_admin");
  check("is_admin() is true", isAdmin.data === true, isAdmin);

  const created = await rpc<{ id: string; code: string }>(admin, "create_session", {
    p_name: `E2E ${new Date().toISOString()}`,
    p_duration_seconds: 300,
    p_ranking_mode: "correct_then_time",
    p_require_full_card: false,
    p_winners_count: 2,
    p_max_squares_per_coworker: 1,
    p_prompts: DEFAULT_PROMPTS.slice(0, 24),
  });
  check("create_session", !created.error && !!created.data?.code, created.error);
  const longName = await rpc(admin, "create_session", { p_name: "n".repeat(101), p_duration_seconds: 300, p_ranking_mode: "correct_then_time", p_require_full_card: false, p_winners_count: 1, p_max_squares_per_coworker: 1, p_prompts: DEFAULT_PROMPTS.slice(0, 24) });
  check("create_session rejects a 101-char name", longName.error?.includes("INVALID_INPUT") ?? false, longName.error);
  const longDur = await rpc(admin, "create_session", { p_name: "x", p_duration_seconds: 28801, p_ranking_mode: "correct_then_time", p_require_full_card: false, p_winners_count: 1, p_max_squares_per_coworker: 1, p_prompts: DEFAULT_PROMPTS.slice(0, 24) });
  check("create_session rejects duration > 28800", longDur.error?.includes("INVALID_INPUT") ?? false, longDur.error);
  const { id: sessionId, code } = created.data;

  // Realtime: count events the admin dashboard would receive.
  const events = { players: 0, claims: 0, sessions: 0 };
  let subscribed = false;
  const channel = admin
    .channel(`e2e-${sessionId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `session_id=eq.${sessionId}` }, () => events.players++)
    .on("postgres_changes", { event: "*", schema: "public", table: "claims", filter: `session_id=eq.${sessionId}` }, () => events.claims++)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${sessionId}` }, () => events.sessions++)
    .subscribe((s) => {
      if (s === "SUBSCRIBED") subscribed = true;
    });
  for (let i = 0; i < 50 && !subscribed; i++) await sleep(100);
  check("admin realtime channel subscribed", subscribed);
  await sleep(6000); // postgres_changes needs a few seconds to warm up after SUBSCRIBED

  // ---- Players ----
  const anon = newClient();
  const join = (name: string, email: string) =>
    rpc<{ player_id: string; player_token: string; player_code: string }>(anon, "join_session", { p_code: code.toLowerCase(), p_full_name: name, p_email: email });

  const a = await join("Alex Anders", "alex@example.com");
  const b = await join("Priya Patel", "priya@example.com");
  const c = await join("Sam Smith", "sam@example.com");
  check("3 players join (code is case-insensitive)", !a.error && !b.error && !c.error, [a.error, b.error, c.error]);
  const dup = await join("Alex Again", " ALEX@example.com ");
  check("duplicate email rejected with EMAIL_TAKEN", dup.error?.includes("EMAIL_TAKEN") ?? false, dup.error);
  const missing = await join("", "x@example.com");
  check("empty name rejected", !!missing.error, missing.error);

  const poll = async (token: string) => (await rpc<Poll>(anon, "player_poll", { p_token: token })).data;

  const lobby = await poll(a.data.player_token);
  check("poll in lobby", lobby.session.status === "lobby" && lobby.board.length === 25 && lobby.board[12].is_free, lobby.session);
  const early = await rpc(anon, "create_claim", { p_token: a.data.player_token, p_cell_index: 0, p_coworker_code: b.data.player_code });
  check("claim before start rejected (NOT_LIVE)", early.error?.includes("NOT_LIVE") ?? false, early.error);

  const started = await rpc(admin, "start_session", { p_session_id: sessionId });
  check("start_session", !started.error, started.error);

  // A scans B using the full QR URL, lowercased, without the dash.
  const qr = `http://localhost:3000/play/${code}/scan?c=${b.data.player_code.replace("-", "").toLowerCase()}`;
  const claim1 = await rpc<{ claim_id: string; coworker_name: string }>(anon, "create_claim", {
    p_token: a.data.player_token, p_cell_index: 0, p_coworker_code: qr,
  });
  check("A scans B via QR URL", !claim1.error && claim1.data.coworker_name === "Priya Patel", claim1.error);

  const self = await rpc(anon, "create_claim", { p_token: a.data.player_token, p_cell_index: 1, p_coworker_code: a.data.player_code });
  check("self scan rejected", self.error?.includes("SELF_SCAN") ?? false, self.error);
  const reuse = await rpc(anon, "create_claim", { p_token: a.data.player_token, p_cell_index: 2, p_coworker_code: b.data.player_code });
  check("same coworker twice rejected (limit 1)", reuse.error?.includes("COWORKER_LIMIT") ?? false, reuse.error);
  const selfName = await rpc(anon, "create_claim", { p_token: a.data.player_token, p_cell_index: 1, p_coworker_code: " ALEX " });
  check("self via username -> SELF_SCAN", selfName.error?.includes("SELF_SCAN") ?? false, selfName.error);
  const selfMail = await rpc(anon, "create_claim", { p_token: a.data.player_token, p_cell_index: 1, p_coworker_code: "Alex@Example.com" });
  check("self via full email -> SELF_SCAN", selfMail.error?.includes("SELF_SCAN") ?? false, selfMail.error);
  const byName = await rpc(anon, "create_claim", { p_token: a.data.player_token, p_cell_index: 2, p_coworker_code: "PRIYA" });
  check("username matches coworker (then hits limit 1)", byName.error?.includes("COWORKER_LIMIT") ?? false, byName.error);
  const noUser = await rpc(anon, "create_claim", { p_token: a.data.player_token, p_cell_index: 3, p_coworker_code: "nobody" });
  check("unknown username -> COWORKER_NOT_FOUND", noUser.error?.includes("COWORKER_NOT_FOUND") ?? false, noUser.error);
  const bogus = await rpc(anon, "create_claim", { p_token: a.data.player_token, p_cell_index: 3, p_coworker_code: "ZZZ-ZZZ" });
  check("unknown code rejected", bogus.error?.includes("COWORKER_NOT_FOUND") ?? false, bogus.error);

  const bPoll = await poll(b.data.player_token);
  check("B sees incoming confirmation", bPoll.incoming.length === 1 && bPoll.incoming[0].from_name === "Alex Anders", bPoll.incoming);
  check("poll me.username present, no emails leaked", bPoll.me.username === "priya" && !JSON.stringify(bPoll).includes("@"), bPoll.me);
  const notMine = await rpc(anon, "respond_claim", { p_token: c.data.player_token, p_claim_id: claim1.data.claim_id, p_accept: true });
  check("someone else can't confirm", !!notMine.error, notMine.error);
  const accept = await rpc(anon, "respond_claim", { p_token: b.data.player_token, p_claim_id: bPoll.incoming[0].claim_id, p_accept: true });
  check("B confirms", !accept.error, accept.error);
  const aPoll = await poll(a.data.player_token);
  check("A's cell 0 is confirmed, score 1", aPoll.board[0].status === "confirmed" && aPoll.me.correct === 1, aPoll.board[0]);

  // C scans A, A says no -> cell reopens.
  const claim2 = await rpc<{ claim_id: string }>(anon, "create_claim", { p_token: c.data.player_token, p_cell_index: 5, p_coworker_code: a.data.player_code });
  await rpc(anon, "respond_claim", { p_token: a.data.player_token, p_claim_id: claim2.data.claim_id, p_accept: false });
  const cPoll = await poll(c.data.player_token);
  check("rejected claim reopens cell", cPoll.board[5].status === null && cPoll.board[5].last_outcome === "rejected", cPoll.board[5]);

  // C scans B, then cancels.
  const claim3 = await rpc<{ claim_id: string }>(anon, "create_claim", { p_token: c.data.player_token, p_cell_index: 6, p_coworker_code: b.data.player_code });
  const cancel = await rpc(anon, "cancel_claim", { p_token: c.data.player_token, p_claim_id: claim3.data.claim_id });
  check("cancel pending claim", !cancel.error && (await poll(b.data.player_token)).incoming.length === 0, cancel.error);

  // B scans A and C; both confirm -> B has 2.
  for (const [cell, target] of [[0, a], [1, c]] as const) {
    const cl = await rpc<{ claim_id: string }>(anon, "create_claim", { p_token: b.data.player_token, p_cell_index: cell, p_coworker_code: target.data.player_code });
    await rpc(anon, "respond_claim", { p_token: target.data.player_token, p_claim_id: cl.data.claim_id, p_accept: true });
  }
  const submit = await rpc<{ correct: number }>(anon, "submit_board", { p_token: b.data.player_token });
  check("B submits with 2 correct", submit.data?.correct === 2, submit);
  const late = await rpc(anon, "create_claim", { p_token: b.data.player_token, p_cell_index: 2, p_coworker_code: a.data.player_code });
  check("claim after submit rejected", late.error?.includes("ALREADY_SUBMITTED") ?? false, late.error);

  // ---- Security ----
  const leakPlayers = await anon.from("players").select("*");
  const leakClaims = await anon.from("claims").select("*");
  check("anon can't read players", !!leakPlayers.error || (leakPlayers.data ?? []).length === 0, leakPlayers.data?.length);
  check("anon can't read claims", !!leakClaims.error || (leakClaims.data ?? []).length === 0, leakClaims.data?.length);
  const anonLb = await rpc(anon, "session_leaderboard", { p_session_id: sessionId });
  check("anon can't call admin RPCs", !!anonLb.error, anonLb.error);
  const tokenRead = await admin.from("players").select("player_token").eq("session_id", sessionId);
  check("admin can't read player tokens", !!tokenRead.error, tokenRead.data);
  const adminRead = await admin.from("players").select("id, full_name, email").eq("session_id", sessionId);
  check("admin can read player list", (adminRead.data ?? []).length === 3, adminRead.error);
  const list = await rpc<{ id: string; player_count: number }[]>(admin, "admin_sessions");
  check("admin sessions list shows 3 players", Number(list.data?.find((s) => s.id === sessionId)?.player_count) === 3, list.error ?? list.data);
  const anonList = await rpc(anon, "admin_sessions");
  check("anon can't list sessions", !!anonList.error, anonList.error);

  // ---- Leaderboard / activity ----
  type Row = { full_name: string; correct: number; rank: number | null; is_winner: boolean; prize_rank: number | null };
  const lb = await rpc<Row[]>(admin, "session_leaderboard", { p_session_id: sessionId });
  check("leaderboard: Priya 1st (2), Alex 2nd (1), Sam not a winner (0)",
    lb.data?.[0]?.full_name === "Priya Patel" && lb.data[0].prize_rank === 1 &&
    lb.data[1]?.full_name === "Alex Anders" && lb.data[1].prize_rank === 2 &&
    lb.data[2]?.full_name === "Sam Smith" && !lb.data[2].is_winner, lb.data);
  const activity = await rpc<unknown[]>(admin, "session_activity", { p_session_id: sessionId, p_limit: 20 });
  check("activity feed has 3 confirmations", (activity.data ?? []).length === 3, activity.error ?? activity.data);
  const now = await rpc<string>(admin, "server_now");
  check("server_now works", !now.error && !!now.data, now.error);

  const ended = await rpc(admin, "end_session", { p_session_id: sessionId });
  check("end_session", !ended.error, ended.error);
  const final = await poll(b.data.player_token);
  check("ended poll returns result (rank 1, winner)", final.session.status === "ended" && final.result?.rank === 1 && final.result.is_winner, final.result);

  // ---- Item 4: admin player controls ----
  {
    const sq = await rpc<{ claim_id: string; cell_index: number; coworker_name: string }[]>(admin, "admin_player_squares", { p_player_id: a.data.player_id });
    check("admin_player_squares lists A's confirmed square", !sq.error && sq.data.length >= 1, sq);
    const anonDenied = await rpc(anon, "admin_remove_player", { p_player_id: a.data.player_id });
    check("anon cannot call admin_remove_player", !!anonDenied.error, anonDenied);
    const rv = await rpc<{ status: string }>(admin, "admin_revoke_claim", { p_claim_id: sq.data[0].claim_id });
    check("admin_revoke_claim", !rv.error && rv.data.status === "revoked", rv);
    const after = await poll(a.data.player_token);
    check("revoked square reopens on A's board", after.board[sq.data[0].cell_index].status === null, after.board[sq.data[0].cell_index]);
    check("revoked square reports last_outcome 'revoked'", after.board[sq.data[0].cell_index].last_outcome === "revoked", after.board[sq.data[0].cell_index]);
    const rm = await rpc<{ removed: boolean; squares_lost_by_others: number }>(admin, "admin_remove_player", { p_player_id: c.data.player_id });
    check("admin_remove_player", !rm.error && rm.data.removed === true, rm);
    const gonePoll = await rpc(anon, "player_poll", { p_token: c.data.player_token });
    check("removed player's poll gets INVALID_TOKEN", gonePoll.error?.includes("INVALID_TOKEN") ?? false, gonePoll.error);
  }

  await sleep(1500);
  console.log(`  realtime events seen: players=${events.players} claims=${events.claims} sessions=${events.sessions}`);
  check("realtime: claims events delivered", events.claims > 0);
  check("realtime: sessions events delivered", events.sessions > 0);
  check("realtime: players events delivered", events.players > 0);
  await admin.removeChannel(channel);

  // ---- Item 5: manage admins ----
  {
    const list = await rpc<{ user_id: string; email: string; is_me: boolean }[]>(admin, "admin_list");
    check("admin_list includes me", !list.error && list.data.some((r) => r.is_me && r.email === ADMIN_EMAIL), list);
    const anonList2 = await rpc(anon, "admin_list");
    check("anon cannot call admin_list", !!anonList2.error, anonList2);
    const nf = await rpc(admin, "admin_add", { p_email: "nobody-here@example.invalid" });
    check("admin_add unknown email -> USER_NOT_FOUND", nf.error?.includes("USER_NOT_FOUND") ?? false, nf.error);
    const self = await rpc(admin, "admin_remove", { p_user_id: list.data.find((r) => r.is_me)?.user_id });
    check("admin_remove self -> CANNOT_REMOVE_SELF", self.error?.includes("CANNOT_REMOVE_SELF") ?? false, self.error);
    const notAdmin = await rpc(admin, "admin_remove", { p_user_id: "00000000-0000-0000-0000-00000000dead" });
    // With a single admin LAST_ADMIN wins; with several it is USER_NOT_FOUND (covered in test:db). Never {removed:true}.
    check("admin_remove of a non-admin id is refused", !!notAdmin.error && /USER_NOT_FOUND|LAST_ADMIN/.test(notAdmin.error), notAdmin);
    const again = await rpc<{ added: boolean }>(admin, "admin_add", { p_email: ADMIN_EMAIL.toUpperCase() });
    check("admin_add existing admin is a no-op", !again.error && again.data.added === false, again);
  }
  // ---- admin_create: admin creates an account that can sign in immediately ----
  {
    const stamp = Date.now();
    const newEmail = `e2e-admin-${stamp}@example.test`;
    const newPass = `pw-${stamp}-ok`;
    try {
      const cNoPw = await rpc(admin, "admin_create", { p_email: newEmail });
      check("admin_create new email without password -> PASSWORD_REQUIRED", cNoPw.error?.includes("PASSWORD_REQUIRED") ?? false, cNoPw.error);
      const cWeak = await rpc(admin, "admin_create", { p_email: newEmail, p_password: "short" });
      check("admin_create short password -> WEAK_PASSWORD", cWeak.error?.includes("WEAK_PASSWORD") ?? false, cWeak.error);
      const anonCreate = await rpc(anon, "admin_create", { p_email: newEmail, p_password: newPass });
      check("anon cannot call admin_create", !!anonCreate.error, anonCreate);
      const made = await rpc<{ user_id: string; created: boolean; added: boolean }>(admin, "admin_create", { p_email: newEmail.toUpperCase(), p_password: newPass });
      check("admin_create makes a new account", !made.error && made.data.created === true && made.data.added === true, made);
      const fresh = newClient();
      const si = await fresh.auth.signInWithPassword({ email: newEmail, password: newPass });
      check("new account signs in with email + password", !si.error && !!si.data.session, si.error?.message);
      const freshList = await rpc<{ email: string }[]>(fresh, "admin_list");
      check("new admin can call admin_list and sees themselves", !freshList.error && freshList.data.some((r) => r.email === newEmail), freshList);
      const wrong = await newClient().auth.signInWithPassword({ email: newEmail, password: "wrong-password-1" });
      check("new account rejects a wrong password", !!wrong.error);
      const upd = await fresh.auth.updateUser({ password: `${newPass}-changed` });
      check("new admin can change their own password", !upd.error, upd.error?.message);
      const second = await rpc<{ user_id: string; created: boolean; added: boolean }>(admin, "admin_create", { p_email: newEmail, p_password: "ignored-password-1" });
      check("admin_create existing email: created false, added false", !second.error && second.data.created === false && second.data.added === false && second.data.user_id === made.data.user_id, second);
      const stillOld = await newClient().auth.signInWithPassword({ email: newEmail, password: `${newPass}-changed` });
      check("existing user's password was not overwritten", !stillOld.error, stillOld.error?.message);
      // existing account that is no longer an admin gets re-added
      const rem = await rpc(admin, "admin_remove", { p_user_id: made.data.user_id });
      const readd = await rpc<{ created: boolean; added: boolean }>(admin, "admin_create", { p_email: newEmail });
      check("admin_create re-adds an existing non-admin account", !rem.error && !readd.error && readd.data.created === false && readd.data.added === true, [rem.error, readd]);
    } finally {
      try {
        execSync(`docker exec supabase_db_coworker-bingo psql -U postgres -c "delete from admins where user_id in (select id from auth.users where email = '${newEmail}'); delete from auth.users where email = '${newEmail}';"`, { stdio: "ignore" });
      } catch {
        console.log(`  (could not clean up ${newEmail}; delete it manually)`);
      }
    }
  }
  // ---- Item 14: Post-event stats ----
  type StatsJson = {
    participation: { joined: number; active: number; submitted: number };
    squares: { confirmed: number; distribution: unknown[] };
    prompts: { found_count: number }[];
    people: { total_unique_connections: number; top_connected: unknown[] };
  };
  // Compare with the leaderboard (earlier blocks may have removed players or undone squares).
  const lbNow = await rpc<{ correct: number }[]>(admin, "session_leaderboard", { p_session_id: sessionId });
  const expectJoined = lbNow.data?.length ?? -1;
  const expectConfirmed = (lbNow.data ?? []).reduce((n, r) => n + Number(r.correct), 0);
  const stats = await rpc<StatsJson>(admin, "session_stats", { p_session_id: sessionId });
  check("session_stats: participation and squares match leaderboard", stats.data?.participation.joined === expectJoined && stats.data.squares.confirmed === expectConfirmed && stats.data.squares.distribution.length === 7, stats.error ?? { joined: stats.data?.participation.joined, confirmed: stats.data?.squares.confirmed, expectJoined, expectConfirmed });
  check("session_stats: 24 prompts, found counts sum to confirmed", stats.data?.prompts.length === 24 && stats.data.prompts.reduce((n, p) => n + Number(p.found_count), 0) === expectConfirmed, stats.error ?? "prompt counts off");
  check("session_stats: connections present", (stats.data?.people.total_unique_connections ?? 0) >= 1 && (stats.data?.people.top_connected.length ?? 0) >= 1, stats.error ?? stats.data?.people);
  const anonStats = await rpc(anon, "session_stats", { p_session_id: sessionId });
  check("anon can't call session_stats", !!anonStats.error, anonStats.error);
  // ---- Item 2: allowed email domains ----
  {
    const dom = await rpc<{ id: string; code: string }>(admin, "create_session", {
      p_name: "E2E domains", p_duration_seconds: 300, p_ranking_mode: "correct_then_time",
      p_require_full_card: false, p_winners_count: 1, p_max_squares_per_coworker: 1,
      p_prompts: DEFAULT_PROMPTS.slice(0, 24), p_allowed_email_domains: ["Acme.com"],
    });
    check("create_session with allowed domains", !dom.error && !!dom.data?.code, dom.error);
    const info = await rpc<{ allowed_email_domains: string[] }>(anon, "session_join_info", { p_code: dom.data.code });
    check("session_join_info (anon) returns domains", info.data?.allowed_email_domains?.[0] === "acme.com", info);
    const bad = await rpc(anon, "join_session", { p_code: dom.data.code, p_full_name: "Gmail", p_email: "g@gmail.com" });
    check("join with other domain rejected (EMAIL_DOMAIN)", bad.error?.includes("EMAIL_DOMAIN") ?? false, bad.error);
    const good = await rpc(anon, "join_session", { p_code: dom.data.code, p_full_name: "Acme", p_email: "a@acme.com" });
    check("join with allowed domain works", !good.error, good.error);
    await admin.from("sessions").delete().eq("id", dom.data.id);
  }

  // ---- Item 3: edit a session before it starts ----
  {
    const base = {
      p_name: "E2E edit", p_duration_seconds: 300, p_ranking_mode: "correct_then_time",
      p_require_full_card: false, p_winners_count: 1, p_max_squares_per_coworker: 1,
      p_prompts: DEFAULT_PROMPTS.slice(0, 24),
    };
    const ed = await rpc<{ id: string; code: string }>(admin, "create_session", base);
    const upd = await rpc(admin, "update_session", {
      p_session_id: ed.data.id, ...base, p_name: "E2E edited", p_duration_seconds: 600,
      p_allowed_email_domains: ["acme.com"], p_prompts: DEFAULT_PROMPTS.slice(0, 24).map((p) => `${p}!`),
    });
    check("update_session in lobby", !upd.error, upd.error);
    const row = await admin.from("sessions").select("name, duration_seconds, allowed_email_domains").eq("id", ed.data.id).single();
    check("update_session saved fields", row.data?.name === "E2E edited" && row.data.duration_seconds === 600 && row.data.allowed_email_domains?.[0] === "acme.com", row.data);
    const anonUpd = await rpc(anon, "update_session", { p_session_id: ed.data.id, ...base, p_allowed_email_domains: [] });
    check("anon can't update_session", !!anonUpd.error, anonUpd.error);
    await rpc(admin, "start_session", { p_session_id: ed.data.id });
    const late2 = await rpc(admin, "update_session", { p_session_id: ed.data.id, ...base, p_allowed_email_domains: [] });
    check("update_session after start rejected (ALREADY_STARTED)", late2.error?.includes("ALREADY_STARTED") ?? false, late2.error);
    await admin.from("sessions").delete().eq("id", ed.data.id);
  }

  // ---- Prompt pool: 50 prompts, each player gets a random 24 ----
  {
    const pool = Array.from({ length: 50 }, (_, i) => `E2E pool ${i + 1}`);
    const base = {
      p_name: "E2E pool", p_duration_seconds: 300, p_ranking_mode: "correct_then_time",
      p_require_full_card: false, p_winners_count: 1, p_max_squares_per_coworker: 3,
    };
    const few = await rpc(admin, "create_session", { ...base, p_prompts: pool.slice(0, 23) });
    check("pool: 23 prompts -> PROMPT_COUNT", few.error?.includes("PROMPT_COUNT") ?? false, few.error);
    const lots = await rpc(admin, "create_session", { ...base, p_prompts: Array.from({ length: 201 }, (_, i) => `x${i}`) });
    check("pool: 201 prompts -> PROMPT_COUNT", lots.error?.includes("PROMPT_COUNT") ?? false, lots.error);
    const dup = await rpc(admin, "create_session", { ...base, p_prompts: [...pool.slice(0, 23), ` ${pool[0].toUpperCase()}`] });
    check("pool: duplicate -> DUPLICATE_PROMPT", dup.error?.includes("DUPLICATE_PROMPT") ?? false, dup.error);
    const ps = await rpc<{ id: string; code: string }>(admin, "create_session", { ...base, p_prompts: pool });
    check("pool: create_session with 50 prompts", !ps.error && !!ps.data?.code, ps.error);
    const joinP = async (n: number) =>
      (await rpc<{ player_token: string; player_code: string }>(anon, "join_session", { p_code: ps.data.code, p_full_name: `Pool ${n}`, p_email: `pool${n}@example.com` })).data;
    const players = [await joinP(1), await joinP(2), await joinP(3)];
    const boardPrompts = async (pl: { player_token: string }) => {
      return (await rpc<{ board: (Cell & { prompt: string | null })[] }>(anon, "player_poll", { p_token: pl.player_token })).data.board;
    };
    const verify = async (from: string[]) => {
      const sigs: string[] = [];
      let good = true;
      for (const pl of players) {
        const b = await boardPrompts(pl);
        const texts = b.filter((c) => !c.is_free).map((c) => c.prompt as string);
        good = good && b.length === 25 && b[12].is_free && texts.length === 24 && new Set(texts).size === 24 && texts.every((t) => from.includes(t));
        sigs.push(texts.join("|"));
      }
      return { good, differ: new Set(sigs).size > 1 };
    };
    const v1 = await verify(pool);
    check("pool: each board has 24 distinct prompts from the pool + FREE at 12", v1.good);
    check("pool: boards differ across players", v1.differ);
    const pool2 = Array.from({ length: 36 }, (_, i) => `E2E second ${i + 1}`);
    const re = await rpc(admin, "update_session", { p_session_id: ps.data.id, ...base, p_allowed_email_domains: [], p_prompts: pool2 });
    check("pool: update_session with joined players", !re.error, re.error);
    const v2 = await verify(pool2);
    check("pool: boards rebuilt from the new pool", v2.good && v2.differ);
    const start = await rpc(admin, "start_session", { p_session_id: ps.data.id });
    check("pool: start_session works", !start.error, start.error);
    const cl = await rpc(anon, "create_claim", { p_token: players[0].player_token, p_cell_index: 0, p_coworker_code: players[1].player_code });
    check("pool: claim works", !cl.error, cl.error);
    const st = await rpc<{ prompts: { boards_count: number }[] }>(admin, "session_stats", { p_session_id: ps.data.id });
    check("pool: session_stats reports boards_count per prompt (36 prompts, 72 slots)",
      st.data?.prompts?.length === 36 && st.data.prompts.reduce((n, x) => n + x.boards_count, 0) === 72, st.error);
    await admin.from("sessions").delete().eq("id", ps.data.id);
  }

  // ---- Username option (allow_username_claims) ----
  {
    const mk = async (flag: boolean | undefined, name: string) => {
      const args: Record<string, unknown> = {
        p_name: name, p_duration_seconds: 300, p_ranking_mode: "correct_then_time",
        p_require_full_card: false, p_winners_count: 1, p_max_squares_per_coworker: 5,
        p_prompts: DEFAULT_PROMPTS.slice(0, 24),
      };
      if (flag !== undefined) args.p_allow_username_claims = flag;
      const sess = await rpc<{ id: string; code: string }>(admin, "create_session", args);
      const pa = await rpc<{ player_token: string; player_code: string }>(anon, "join_session", { p_code: sess.data.code, p_full_name: "Una", p_email: "una@example.com" });
      const pb = await rpc<{ player_token: string; player_code: string }>(anon, "join_session", { p_code: sess.data.code, p_full_name: "Vic", p_email: "vic@example.com" });
      await rpc(admin, "start_session", { p_session_id: sess.data.id });
      return { sess, pa, pb };
    };
    const claimWith = (t: { player_token: string }, cell: number, who: string) =>
      rpc(anon, "create_claim", { p_token: t.player_token, p_cell_index: cell, p_coworker_code: who });
    const off = await mk(false, "E2E no usernames");
    const byUser = await claimWith(off.pa.data, 0, "vic");
    check("flag off: username -> COWORKER_NOT_FOUND", byUser.error?.includes("COWORKER_NOT_FOUND") ?? false, byUser.error);
    const byMail = await claimWith(off.pa.data, 0, "vic@example.com");
    check("flag off: email -> COWORKER_NOT_FOUND", byMail.error?.includes("COWORKER_NOT_FOUND") ?? false, byMail.error);
    const byCode = await claimWith(off.pa.data, 0, off.pb.data.player_code);
    check("flag off: player code still works", !byCode.error, byCode.error);
    const offPoll = await rpc<{ session: { allow_username_claims: boolean; require_full_card: boolean } }>(anon, "player_poll", { p_token: off.pa.data.player_token });
    check("poll returns allow_username_claims=false", offPoll.data?.session.allow_username_claims === false && offPoll.data.session.require_full_card === false, offPoll.data?.session);
    const on = await mk(undefined, "E2E usernames default");
    const onUser = await claimWith(on.pa.data, 0, "vic");
    check("flag on (default): username works", !onUser.error, onUser.error);
    const onPoll = await rpc<{ session: { allow_username_claims: boolean } }>(anon, "player_poll", { p_token: on.pa.data.player_token });
    check("poll returns allow_username_claims=true", onPoll.data?.session.allow_username_claims === true, onPoll.data?.session);
    await admin.from("sessions").delete().in("id", [off.sess.data.id, on.sess.data.id]);
  }

  // ---- Item 6: bingo lines mode ----
  {
    const lc = await rpc<{ id: string; code: string }>(admin, "create_session", {
      p_name: "E2E lines", p_duration_seconds: 300, p_ranking_mode: "lines",
      p_require_full_card: false, p_winners_count: 1, p_max_squares_per_coworker: 24,
      p_prompts: DEFAULT_PROMPTS.slice(0, 24), p_allowed_email_domains: [], p_lines_to_win: 1,
    });
    check("create_session in lines mode", !lc.error && !!lc.data?.code, lc.error);
    await rpc(admin, "start_session", { p_session_id: lc.data.id });
    const lp = await rpc<{ player_token: string; player_code: string }>(anon, "join_session", { p_code: lc.data.code, p_full_name: "Liner", p_email: "liner@example.com" });
    const lq = await rpc<{ player_token: string; player_code: string }>(anon, "join_session", { p_code: lc.data.code, p_full_name: "Friend", p_email: "friend@example.com" });
    // four squares of the middle row complete a line (FREE centre counts)
    for (const cell of [10, 11, 13, 14]) {
      const cl = await rpc<{ claim_id: string }>(anon, "create_claim", { p_token: lp.data.player_token, p_cell_index: cell, p_coworker_code: lq.data.player_code });
      await rpc(anon, "respond_claim", { p_token: lq.data.player_token, p_claim_id: cl.data.claim_id, p_accept: true });
    }
    const lpoll = await rpc<{ me: { lines: number }; session: { ranking_mode: string; lines_to_win: number } }>(anon, "player_poll", { p_token: lp.data.player_token });
    check("lines mode poll: 1 line after 4 middle-row squares", lpoll.data?.me.lines === 1 && lpoll.data.session.ranking_mode === "lines", lpoll.data);
    const llb = await rpc<{ full_name: string; lines: number; eligible: boolean; reach_seconds: number | null; rank: number | null }[]>(admin, "session_leaderboard", { p_session_id: lc.data.id });
    check("lines leaderboard: Liner eligible with reach time, ranked first",
      llb.data?.[0]?.full_name === "Liner" && llb.data[0].lines === 1 && llb.data[0].eligible && llb.data[0].reach_seconds !== null && llb.data[0].rank === 1, llb.data);
    await admin.from("sessions").delete().eq("id", lc.data.id);
  }

  // ---- Item 7: extend time and pause/resume ----
  {
    const ps = await rpc<{ id: string; code: string }>(admin, "create_session", {
      p_name: "E2E pause", p_duration_seconds: 300, p_ranking_mode: "correct_then_time",
      p_require_full_card: false, p_winners_count: 1, p_max_squares_per_coworker: 1,
      p_prompts: DEFAULT_PROMPTS.slice(0, 24),
    });
    await rpc(admin, "start_session", { p_session_id: ps.data.id });
    const x = await rpc<{ player_token: string; player_code: string }>(anon, "join_session", { p_code: ps.data.code, p_full_name: "Pauser", p_email: "pauser@example.com" });
    const y = await rpc<{ player_token: string; player_code: string }>(anon, "join_session", { p_code: ps.data.code, p_full_name: "Buddy", p_email: "buddy2@example.com" });
    const ext = await rpc<{ duration_seconds: number }>(admin, "extend_session", { p_session_id: ps.data.id, p_seconds: 60 });
    check("extend_session +60s", ext.data?.duration_seconds === 360, ext.error ?? ext.data);
    const badExt = await rpc(admin, "extend_session", { p_session_id: ps.data.id, p_seconds: 7200 });
    check("extend_session rejects > 3600s", !!badExt.error, badExt.error);
    const anonPause = await rpc(anon, "pause_session", { p_session_id: ps.data.id });
    check("anon can't pause_session", !!anonPause.error, anonPause.error);
    const paused = await rpc(admin, "pause_session", { p_session_id: ps.data.id });
    check("pause_session", !paused.error, paused.error);
    const pp = await rpc<{ session: { status: string; paused: boolean; paused_at: string | null } }>(anon, "player_poll", { p_token: x.data.player_token });
    check("poll while paused: live + paused + paused_at", pp.data?.session.status === "live" && pp.data.session.paused && !!pp.data.session.paused_at, pp.data);
    const blocked = await rpc(anon, "create_claim", { p_token: x.data.player_token, p_cell_index: 0, p_coworker_code: y.data.player_code });
    check("create_claim while paused -> PAUSED", blocked.error?.includes("PAUSED") ?? false, blocked.error);
    const subPaused = await rpc(anon, "submit_board", { p_token: y.data.player_token });
    check("submit_board allowed while paused", !subPaused.error, subPaused.error);
    const again = await rpc(admin, "pause_session", { p_session_id: ps.data.id });
    check("pause twice -> ALREADY_PAUSED", again.error?.includes("ALREADY_PAUSED") ?? false, again.error);
    await sleep(1200);
    const resumed = await rpc(admin, "resume_session", { p_session_id: ps.data.id });
    check("resume_session", !resumed.error, resumed.error);
    const ok2 = await rpc(anon, "create_claim", { p_token: x.data.player_token, p_cell_index: 0, p_coworker_code: y.data.player_code });
    check("create_claim works after resume", !ok2.error, ok2.error);
    const endedPaused = await rpc(admin, "pause_session", { p_session_id: ps.data.id });
    const endNow = await rpc(admin, "end_session", { p_session_id: ps.data.id });
    check("end_session while paused", !endedPaused.error && !endNow.error, endNow.error ?? endedPaused.error);
    await admin.from("sessions").delete().eq("id", ps.data.id);
  }

  // ---- admin_db_health (0016) ----
  {
    const h = await rpc<Record<string, unknown>>(admin, "admin_db_health");
    check("admin_db_health returns numeric aggregates for an admin", !h.error && typeof h.data.conn_total === "number" && typeof h.data.xact_commit === "number" && typeof h.data.db_size_bytes === "number" && Array.isArray(h.data.unavailable), h);
    const denied = await rpc(anon, "admin_db_health");
    check("anon cannot call admin_db_health", !!denied.error, denied);
  }

  const del = await admin.from("sessions").delete().eq("id", sessionId);
  const gone = await admin.from("players").select("id").eq("session_id", sessionId);
  check("delete session cascades", !del.error && (gone.data ?? []).length === 0, del.error);

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll end-to-end checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
