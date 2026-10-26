/**
 * End-to-end check against a running LOCAL Supabase (`npx supabase start`).
 * Exercises the real API: admin auth, every RPC, RLS and admin realtime events.
 *
 *   npm run e2e:local
 */
import { readFileSync } from "node:fs";
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
  me: { player_code: string; correct: number; submitted_at: string | null };
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
  const bogus = await rpc(anon, "create_claim", { p_token: a.data.player_token, p_cell_index: 3, p_coworker_code: "ZZZ-ZZZ" });
  check("unknown code rejected", bogus.error?.includes("COWORKER_NOT_FOUND") ?? false, bogus.error);

  const bPoll = await poll(b.data.player_token);
  check("B sees incoming confirmation", bPoll.incoming.length === 1 && bPoll.incoming[0].from_name === "Alex Anders", bPoll.incoming);
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
