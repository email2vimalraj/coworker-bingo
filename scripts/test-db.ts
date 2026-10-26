/**
 * Verifies supabase/migrations/0001_init.sql against an in-process Postgres (PGlite).
 * Supabase pieces are stubbed: auth.users, auth.uid(), roles anon/authenticated.
 * Run: npm run test:db
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join as pjoin } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { rankPlayers, type RankingMode } from "../lib/ranking";

const root = pjoin(__dirname, "..");
const db = new PGlite({ extensions: { citext } });

const STUB = `
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create role anon nologin;
create role authenticated nologin;
grant usage on schema public, auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
`;

type Row = Record<string, unknown>;
const ADMIN = "00000000-0000-0000-0000-0000000000a1";
const OTHER_USER = "00000000-0000-0000-0000-0000000000b2";

async function as<T>(role: "anon" | "authenticated" | "postgres", sub: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [sub ?? ""]);
  await db.exec(role === "postgres" ? "reset role" : `set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
  (await db.query<Row>(sql, params)).rows;
const rpc = async (fn: string, args: unknown[]): Promise<Row> => {
  const ph = args.map((_, i) => `$${i + 1}`).join(", ");
  return (await q(`select ${fn}(${ph}) as r`, args))[0].r as Row;
};
async function expectErr(code: string, p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert.ok(String((e as Error).message).includes(code), `expected ${code}, got ${(e as Error).message}`);
    return;
  }
  assert.fail(`expected error ${code}`);
}
let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`  ok  ${name}`);
}

interface Joined { player_id: string; player_token: string; player_code: string }
interface Poll {
  session: Row; server_now: string; me: Row; board: Row[]; incoming: Row[]; result: Row | null;
}

async function main() {
  await db.exec(STUB);
  const migDir = pjoin(root, "supabase/migrations");
  for (const f of readdirSync(migDir).filter((n) => n.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(pjoin(migDir, f), "utf8"));
  }
  await db.exec(readFileSync(pjoin(root, "supabase/seed.sql"), "utf8"));
  await q("insert into auth.users(id) values ($1), ($2)", [ADMIN, OTHER_USER]);
  await q("insert into admins(user_id) values ($1)", [ADMIN]);
  ok("migration + seed load");
  const demo = await q("select count(*)::int as n from session_prompts");
  assert.equal(demo[0].n, 24);

  // --- RLS / grants
  await as("anon", null, async () => {
    await expectErr("permission denied", q("select * from sessions"));
    await expectErr("permission denied", q("select * from players"));
    await expectErr("permission denied", rpc("session_leaderboard", [crypto.randomUUID()]));
  });
  await as("authenticated", OTHER_USER, async () => {
    assert.equal((await q("select * from sessions")).length, 0); // not admin: RLS hides rows
    await expectErr("NOT_ADMIN", rpc("start_session", [crypto.randomUUID()]));
  });
  await as("authenticated", ADMIN, async () => {
    assert.equal((await q("select * from sessions")).length, 1);
  });
  ok("RLS: anon blocked, non-admin sees nothing, admin sees rows");

  // --- create session
  const prompts = Array.from({ length: 24 }, (_, i) => `Prompt ${i + 1}`);
  const create = (p: string[]) =>
    rpc("create_session", ["Test game", 600, "correct_then_time", false, 3, 5, p]);
  const sess = await as("authenticated", ADMIN, async () => {
    await expectErr("PROMPT_COUNT", create(prompts.slice(0, 23)));
    return create(prompts);
  });
  const sid = sess.id as string;
  const code = sess.code as string;
  assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  ok(`create_session with 24 prompts (code ${code})`);

  // --- join in lobby
  const join = (name: string, email: string, c = code) =>
    as("anon", null, () => rpc("join_session", [c, name, email]) as unknown as Promise<Joined>);
  await expectErr("SESSION_NOT_FOUND", join("X", "x@x.io", "ZZZZZZ"));
  await expectErr("INVALID_INPUT", join("", "x@x.io"));
  await expectErr("INVALID_INPUT", join("X", "not-an-email"));
  const players: Joined[] = [];
  const alice = await join("  Alice  ", "  Alice@Example.COM ");
  players.push(alice);
  await expectErr("EMAIL_TAKEN", join("Alice 2", "alice@example.com"));
  assert.match(alice.player_code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{3}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{3}$/);
  const stored = await q("select full_name, email::text as email from players where id=$1", [alice.player_id]);
  assert.deepEqual(stored[0], { full_name: "Alice", email: "alice@example.com" });
  players.push(await join("Bob", "bob@example.com"));
  players.push(await join("Cara", "cara@example.com"));
  ok("join: validation, trimmed/lowercased email, duplicate email rejected");

  const boardRows = await q("select cell_index, prompt_id from boards where player_id=$1 order by 1", [alice.player_id]);
  assert.equal(boardRows.length, 25);
  assert.equal(boardRows[12].prompt_id, null);
  assert.equal(new Set(boardRows.filter((r) => r.cell_index !== 12).map((r) => r.prompt_id)).size, 24);
  ok("board: 25 cells, FREE at 12, 24 distinct prompts");

  const [A, B, C] = players;
  const poll = (p: Joined) => as("anon", null, () => rpc("player_poll", [p.player_token]) as unknown as Promise<Poll>);
  const lobby = await poll(A);
  assert.equal(lobby.session.status, "lobby");
  await expectErr("NOT_LIVE", as("anon", null, () => rpc("create_claim", [A.player_token, 0, B.player_code])));
  await expectErr("INVALID_TOKEN", as("anon", null, () => rpc("player_poll", [crypto.randomUUID()])));

  // --- start
  await as("authenticated", ADMIN, async () => {
    await rpc("start_session", [sid]);
    await expectErr("ALREADY_STARTED", rpc("start_session", [sid]));
  });
  const live = await poll(A);
  assert.equal(live.session.status, "live");
  assert.ok(live.session.ends_at);
  ok("start_session -> live");

  // poll shape
  assert.deepEqual(Object.keys(live).sort(), ["board", "incoming", "me", "result", "server_now", "session"]);
  assert.deepEqual(
    Object.keys(live.session).sort(),
    ["code", "duration_seconds", "ends_at", "lines_to_win", "max_squares_per_coworker", "name", "paused", "paused_at", "ranking_mode", "started_at", "status", "winners_count"],
  );
  assert.deepEqual(Object.keys(live.me).sort(), ["correct", "full_name", "id", "lines", "player_code", "submitted_at"]);
  assert.equal(live.board.length, 25);
  assert.equal(live.board[12].is_free, true);
  assert.equal(live.result, null);
  ok("player_poll shape");

  // late joiner allowed while live
  players.push(await join("Dan", "dan@example.com"));
  const D = players[3];

  // --- claims
  const claim = (p: Joined, cell: number, c: string) =>
    as("anon", null, () => rpc("create_claim", [p.player_token, cell, c]));
  await expectErr("SELF_SCAN", claim(A, 0, A.player_code));
  await expectErr("COWORKER_NOT_FOUND", claim(A, 0, "ZZZ-ZZZ"));
  await expectErr("COWORKER_NOT_FOUND", claim(A, 0, "garbage"));
  await expectErr("INVALID_INPUT", claim(A, 12, B.player_code));
  await expectErr("INVALID_INPUT", claim(A, 25, B.player_code));
  const c1 = await claim(A, 0, B.player_code.toLowerCase().replace("-", ""));
  await expectErr("CELL_TAKEN", claim(A, 0, C.player_code));
  ok("create_claim: self-scan, not found, cell taken, code normalization");

  // Session was created with max 5 per coworker; drop to 1 for the limit test.
  await q("update sessions set max_squares_per_coworker = 1 where id=$1", [sid]);
  await expectErr("COWORKER_LIMIT", claim(A, 1, B.player_code));
  ok("coworker limit enforced");

  // URL form of the code
  const c2 = await claim(A, 1, `https://app.example/play/${code}/scan?c=${C.player_code}`);
  ok("create_claim accepts full URL with c=");

  // incoming for B
  const pb = await poll(B);
  assert.equal(pb.incoming.length, 1);
  assert.equal(pb.incoming[0].from_name, "Alice");
  assert.equal(pb.incoming[0].claim_id, c1.claim_id);
  assert.match(String(pb.incoming[0].prompt), /^Prompt \d+$/);
  const pa = await poll(A);
  assert.equal(pa.board[0].status, "pending");
  assert.equal(pa.board[0].coworker_name, "Bob");
  ok("poll shows incoming and pending cell");

  const respond = (p: Joined, id: unknown, accept: boolean) =>
    as("anon", null, () => rpc("respond_claim", [p.player_token, id, accept]));
  await expectErr("NOT_YOURS", respond(A, c1.claim_id, true));
  await expectErr("NOT_YOURS", respond(C, c1.claim_id, true));
  await expectErr("CLAIM_NOT_FOUND", respond(B, crypto.randomUUID(), true));
  assert.equal((await respond(B, c1.claim_id, true)).status, "confirmed");
  await expectErr("CLAIM_NOT_PENDING", respond(B, c1.claim_id, false));
  assert.equal((await respond(C, c2.claim_id, false)).status, "rejected");
  const pa2 = await poll(A);
  assert.equal(pa2.board[0].status, "confirmed");
  assert.equal(pa2.board[1].status, null);
  assert.equal(pa2.board[1].last_outcome, "rejected");
  assert.equal(pa2.me.correct, 1);
  ok("respond_claim confirm / reject; rejected reopens cell");

  // reopen cell 1 with a different coworker, then cancel
  const c3 = await claim(A, 1, D.player_code);
  await as("anon", null, () => rpc("cancel_claim", [A.player_token, c3.claim_id]));
  await expectErr("CLAIM_NOT_FOUND", as("anon", null, () => rpc("cancel_claim", [A.player_token, c3.claim_id])));
  const c4 = await claim(A, 1, C.player_code); // C again: rejected claim doesn't count to limit
  ok("cancel_claim and re-claim after reject");

  // stale pending claim expires (2 minutes)
  await q("update claims set created_at = now() - interval '3 minutes' where id=$1", [c4.claim_id]);
  await expectErr("CLAIM_NOT_PENDING", respond(C, c4.claim_id, true));
  const pc = await poll(C);
  assert.equal(pc.incoming.length, 0);
  assert.equal(((await q("select status from claims where id=$1", [c4.claim_id]))[0].status), "expired");
  ok("pending claims older than 2 minutes expire");

  // submit
  await expectErr("ALREADY_SUBMITTED", (async () => {
    await as("anon", null, () => rpc("submit_board", [A.player_token]));
    await as("anon", null, () => rpc("submit_board", [A.player_token]));
  })());
  await expectErr("ALREADY_SUBMITTED", claim(A, 2, D.player_code));
  ok("submit_board locks the board");

  // --- time up (simulate by moving ends_at into the past without calling end_session)
  await q("update sessions set started_at = now() - interval '700 seconds', ends_at = now() - interval '100 seconds' where id=$1", [sid]);
  await expectErr("TIME_UP", claim(B, 0, C.player_code));
  await expectErr("TIME_UP", as("anon", null, () => rpc("submit_board", [B.player_token])));
  const pended = await poll(B);
  assert.equal(pended.session.status, "ended");
  assert.ok(pended.result);
  assert.deepEqual(Object.keys(pended.result!).sort(), ["correct", "elapsed_seconds", "is_winner", "lines", "prize_rank", "rank", "reach_seconds"]);
  await expectErr("SESSION_ENDED", join("Late", "late@example.com"));
  ok("effective status ended after ends_at: TIME_UP, result in poll, join blocked");

  // respond TIME_UP with a pending claim
  await q("update sessions set started_at = now() - interval '10 seconds', ends_at = now() + interval '590 seconds' where id=$1", [sid]);
  const c5 = await claim(B, 3, D.player_code);
  await q("update sessions set ends_at = now() - interval '1 second' where id=$1", [sid]);
  await expectErr("TIME_UP", respond(D, c5.claim_id, true));
  ok("respond_claim rejects with TIME_UP");

  // --- leaderboard vs lib/ranking.ts with many players and all four configs
  const many: Joined[] = [];
  await q("update sessions set status='live', started_at = now() - interval '600 seconds', ends_at = now() + interval '600 seconds', ended_at = null, max_squares_per_coworker = 24 where id=$1", [sid]);
  for (let i = 0; i < 12; i++) many.push(await join(`P${i}`, `p${i}@example.com`));
  const ids = many.map((m) => m.player_id);
  // confirmed counts (insert directly; coworker = another player)
  const counts = [24, 24, 24, 24, 23, 23, 10, 10, 10, 0, 0, 5];
  const subSecs = [270, 294, 294, null, 100, null, 50, 50, 60, null, 20, 400];
  for (let i = 0; i < ids.length; i++) {
    for (let k = 0; k < counts[i]; k++) {
      await q(
        "insert into claims(session_id, player_id, coworker_id, cell_index, status) values ($1,$2,$3,$4,'confirmed')",
        [sid, ids[i], ids[(i + 1 + (k % 11)) % ids.length], k < 12 ? k : k + 1],
      );
    }
    if (subSecs[i] !== null) {
      await q("update players set submitted_at = (select started_at from sessions where id=$1) + make_interval(secs => $2) where id=$3", [sid, subSecs[i], ids[i]]);
    }
  }
  // distinct, ordered joined_at to make the final tiebreak deterministic
  for (let i = 0; i < ids.length; i++) {
    await q("update players set joined_at = now() - make_interval(secs => $1) where id=$2", [100 - i, ids[i]]);
  }

  const configs: { mode: RankingMode; full: boolean; winners: number }[] = [
    { mode: "correct_then_time", full: false, winners: 3 },
    { mode: "correct_then_time", full: false, winners: 20 },
    { mode: "correct_then_time", full: true, winners: 3 },
    { mode: "full_card_fastest", full: false, winners: 2 },
    { mode: "full_card_fastest", full: true, winners: 10 },
  ];
  for (const cfg of configs) {
    await q("update sessions set ranking_mode=$1, require_full_card=$2, winners_count=$3 where id=$4", [cfg.mode, cfg.full, cfg.winners, sid]);
    const lb = await as("authenticated", ADMIN, () => q("select * from session_leaderboard($1)", [sid]));
    const s = (await q("select extract(epoch from started_at)*1000 as st from sessions where id=$1", [sid]))[0];
    const pl = await q("select id, extract(epoch from joined_at)*1000 as j, extract(epoch from submitted_at)*1000 as sub from players where session_id=$1", [sid]);
    const correct = new Map((await q("select player_id, count(*)::int as n from claims where status='confirmed' group by 1")).map((r) => [r.player_id, r.n as number]));
    const expected = rankPlayers(
      pl.map((p) => ({ id: p.id as string, correct: correct.get(p.id) ?? 0, joinedAt: Number(p.j), submittedAt: p.sub === null ? null : Number(p.sub) })),
      { mode: cfg.mode, requireFullCard: cfg.full, winnersCount: cfg.winners, startedAt: Number(s.st), durationSeconds: 600 },
    );
    assert.equal(lb.length, expected.length);
    lb.forEach((row, i) => {
      const e = expected[i];
      const label = `${cfg.mode}/${cfg.full}: row ${i}`;
      assert.equal(row.player_id, e.id, `${label} id`);
      assert.equal(row.correct, e.correct, `${label} correct`);
      assert.ok(Math.abs(Number(row.elapsed_seconds) - e.elapsedSeconds) < 0.01, `${label} elapsed`);
      assert.equal(row.eligible, e.eligible, `${label} eligible`);
      assert.equal(row.rank, e.rank, `${label} rank`);
      assert.equal(row.is_winner, e.isWinner, `${label} winner`);
      assert.equal(row.prize_rank, e.prizeRank, `${label} prize`);
    });
    assert.ok(lb.filter((r) => r.correct === 0).every((r) => !r.eligible && !r.is_winner && r.prize_rank === null), "0-correct never wins");
    ok(`leaderboard matches lib/ranking.ts (${cfg.mode}, require_full_card=${cfg.full}, winners=${cfg.winners})`);
  }
  // spot-check semantics: 4.5 min beats 4.9 min
  await q("update sessions set ranking_mode='correct_then_time', require_full_card=false, winners_count=3 where id=$1", [sid]);
  const top = await as("authenticated", ADMIN, () => q("select player_id, rank from session_leaderboard($1)", [sid]));
  assert.equal(top[0].player_id, ids[0]);
  assert.equal(top[1].rank, 2);
  assert.equal(top[2].rank, 2); // tie shares rank
  ok("fastest 24/24 first; ties share rank");

  // --- end_session
  await as("authenticated", ADMIN, async () => {
    const s2 = await rpc("create_session", ["G2", 300, "correct_then_time", false, 1, 1, prompts]);
    await expectErr("SESSION_NOT_FOUND", rpc("end_session", [crypto.randomUUID()]));
    await rpc("start_session", [s2.id]);
    await rpc("end_session", [s2.id]);
    await expectErr("SESSION_ENDED", rpc("end_session", [s2.id]));
    const r = (await q("select status, ended_at is not null as e, ends_at <= now() as p from sessions where id=$1", [s2.id]))[0];
    assert.deepEqual(r, { status: "ended", e: true, p: true });
  });
  ok("end_session");

  // --- stage 3: security hardening
  {
    // every SECURITY DEFINER function pins search_path
    const unpinned = await q("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))");
    assert.deepEqual(unpinned, []);
    // RLS on for every public table
    const noRls = await q("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity");
    assert.deepEqual(noRls, []);
    // anon has no table privileges at all
    const anonTbl = await q("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (has_table_privilege('anon', c.oid, 'select,insert,update,delete') or exists (select 1 from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and has_column_privilege('anon', c.oid, a.attnum, 'select')))");
    assert.deepEqual(anonTbl, []);
    // admin RPCs and internals are not executable by anon / public
    const adminFns = ["create_session(text,int,ranking_mode,boolean,int,int,text[],text[],int)", "_bingo_lines()", "_elapsed_at(uuid,timestamptz)", "pause_session(uuid)", "resume_session(uuid)", "extend_session(uuid,int)", "_paused_seconds(uuid,timestamptz,timestamptz)", "_claim_expired(uuid,timestamptz)", "admin_sessions()", "_normalize_domains(text[])", "update_session(uuid,text,int,ranking_mode,boolean,int,int,text[],text[],int)", "start_session(uuid)", "end_session(uuid)", "session_leaderboard(uuid)", "session_activity(uuid,int)", "server_now()", "_leaderboard(uuid)", "is_admin()"];
    for (const f of adminFns) {
      const r = await q("select has_function_privilege('anon', $1::regprocedure, 'execute') as a, has_function_privilege('public', $1::regprocedure, 'execute') as p", [f]);
      assert.deepEqual(r[0], { a: false, p: false }, f);
    }
    ok("security: search_path pinned, RLS on, anon has no table/admin-function access");

    // player_token is not readable by authenticated admins either, nor present in any output
    await as("authenticated", ADMIN, async () => {
      await expectErr("permission denied", q("select player_token from players"));
      await expectErr("permission denied", q("select * from players"));
      assert.ok((await q("select id, full_name, email from players")).length > 0);
    });
    const tokens = (await q("select player_token::text as t from players")).map((r) => String(r.t));
    const pollJson = JSON.stringify(await poll(A)) + JSON.stringify(await poll(many[0]));
    const lbJson = JSON.stringify(await as("authenticated", ADMIN, () => q("select * from session_leaderboard($1)", [sid])));
    for (const t of tokens) {
      assert.ok(!pollJson.includes(t) && !lbJson.includes(t), "token leaked");
    }
    // a poll shows only the caller's own token-derived data; the join result is the only place a token appears
    ok("player_token never appears in poll/leaderboard output or admin table reads");

    // input limits
    await expectErr("INVALID_INPUT", join("x".repeat(81), "long-name@example.com"));
    await expectErr("INVALID_INPUT", join("Ok", `${"a".repeat(250)}@example.com`));
    await join("y".repeat(80), "max-name@example.com").catch((e) => {
      // session may be ended at this point; only the length check matters
      assert.ok(String(e.message).includes("SESSION_ENDED") || String(e.message).includes("EMAIL"));
    });
    await as("authenticated", ADMIN, async () => {
      await expectErr("INVALID_INPUT", rpc("create_session", ["S", 300, "correct_then_time", false, 1, 1, [...prompts.slice(0, 23), "p".repeat(121)]]));
    });
    ok("input length limits (name 80, email 254, prompt 120)");

    // server_now + session_activity (admin only), activity carries prompt text
    await expectErr("permission denied", as("anon", null, () => q("select server_now()")));
    await as("authenticated", OTHER_USER, async () => {
      await expectErr("NOT_ADMIN", q("select * from session_activity($1, 5)", [sid]));
    });
    await as("authenticated", ADMIN, async () => {
      const sn = await q("select server_now() as n");
      assert.ok(Math.abs(new Date(String(sn[0].n)).getTime() - Date.now()) < 60_000);
      const act = await q("select * from session_activity($1, 5)", [sid]);
      assert.ok(act.length > 0 && act.length <= 5);
      assert.ok(act.every((a) => /^Prompt \d+$/.test(String(a.prompt)) && a.player_name && a.coworker_name));
    });
    ok("server_now and session_activity (with prompt text) are admin-only");

    // concurrency safety nets: unique index blocks a double-filled cell; confirmations respect the per-coworker limit
    const s3 = await as("authenticated", ADMIN, async () => {
      const r = await rpc("create_session", ["G3", 300, "correct_then_time", false, 1, 1, prompts]);
      await rpc("start_session", [r.id]);
      return r;
    });
    const X = await join("Xena", "xena@example.com", s3.code as string);
    const Y = await join("Yuri", "yuri@example.com", s3.code as string);
    await q("insert into claims(session_id, player_id, coworker_id, cell_index) values ($1,$2,$3,0)", [s3.id, X.player_id, Y.player_id]);
    await expectErr("claims_one_active_per_cell", q("insert into claims(session_id, player_id, coworker_id, cell_index) values ($1,$2,$3,0)", [s3.id, X.player_id, Y.player_id]));
    // two pending claims to the same coworker (as if a race slipped through) cannot both be confirmed
    await q("insert into claims(session_id, player_id, coworker_id, cell_index) values ($1,$2,$3,1)", [s3.id, X.player_id, Y.player_id]);
    const pend = await q("select id from claims where player_id=$1 order by cell_index", [X.player_id]);
    assert.equal((await respond(Y, pend[0].id, true)).status, "confirmed");
    await expectErr("COWORKER_LIMIT", respond(Y, pend[1].id, true));
    assert.equal((await respond(Y, pend[1].id, false)).status, "rejected");
    assert.equal(Number((await q("select count(*) as n from claims where player_id=$1 and status='confirmed'", [X.player_id]))[0].n), 1);
    ok("per-coworker limit and one-active-claim-per-cell hold at confirmation time");
  }

  // --- delete cascades
  await as("authenticated", ADMIN, async () => {
    await q("delete from sessions where id=$1", [sid]);
  });
  const left = await q("select (select count(*) from players where session_id=$1)::int as p, (select count(*) from claims where session_id=$1)::int as c", [sid]);
  assert.deepEqual(left[0], { p: 0, c: 0 });
  ok("delete cascades");

  // ---- Item 4: Admin player controls (remove player, revoke square) ----
  {
    const s4 = await as("authenticated", ADMIN, async () => {
      const r = await rpc("create_session", ["Item4", 300, "correct_then_time", false, 1, 1, prompts]);
      await rpc("start_session", [r.id]);
      return r;
    });
    const X = await join("Xi", "xi4@example.com", s4.code as string);
    const Y = await join("Yo", "yo4@example.com", s4.code as string);
    const Z = await join("Zed", "zed4@example.com", s4.code as string);
    const cl = async (p: Joined, cell: number, cw: Joined) => {
      const r = await claim(p, cell, cw.player_code);
      return (await respond(cw, r.claim_id, true)).status;
    };
    assert.equal(await cl(X, 0, Y), "confirmed");
    assert.equal(await cl(X, 1, Z), "confirmed");
    assert.equal(await cl(Y, 3, X), "confirmed");
    const lbOf = (id: unknown) =>
      as("authenticated", ADMIN, async () =>
        (await q("select player_id, correct from session_leaderboard($1)", [id])).find((r) => r.player_id === X.player_id));
    assert.equal((await lbOf(s4.id))?.correct, 2);

    // permissions
    for (const [fn, arg] of [["admin_remove_player", X.player_id], ["admin_player_squares", X.player_id], ["admin_revoke_claim", crypto.randomUUID()]]) {
      await as("authenticated", OTHER_USER, async () => { await expectErr("NOT_ADMIN", q(`select ${fn}($1)`, [arg])); });
      await expectErr("permission denied", as("anon", null, () => q(`select ${fn}($1)`, [arg])));
    }

    const sq = await as("authenticated", ADMIN, () => q("select * from admin_player_squares($1)", [X.player_id]));
    assert.equal(sq.length, 2);
    assert.deepEqual(sq.map((r) => [r.cell_index, r.coworker_name]).sort(), [[0, "Yo"], [1, "Zed"]]);
    assert.ok(sq.every((r) => /^Prompt \d+$/.test(String(r.prompt)) && r.claim_id && r.resolved_at));

    // revoke: score drops, cell reopens, coworker allowance is freed
    const revokeId = sq.find((r) => r.cell_index === 0)!.claim_id;
    const rv = await as("authenticated", ADMIN, () => rpc("admin_revoke_claim", [revokeId]));
    assert.equal(rv.status, "revoked");
    await as("authenticated", ADMIN, async () => { await expectErr("CLAIM_NOT_PENDING", rpc("admin_revoke_claim", [revokeId])); });
    await as("authenticated", ADMIN, async () => { await expectErr("CLAIM_NOT_FOUND", rpc("admin_revoke_claim", [crypto.randomUUID()])); });
    assert.equal((await lbOf(s4.id))?.correct, 1);
    const xp = (await as("anon", null, () => rpc("player_poll", [X.player_token]))) as unknown as Poll;
    assert.equal(xp.board[0].status, null);
    assert.equal(xp.me.correct, 1);
    assert.equal(await cl(X, 0, Y), "confirmed"); // same coworker, same cell again
    assert.equal((await lbOf(s4.id))?.correct, 2);
    ok("admin_revoke_claim reopens the cell, frees the coworker allowance and drops the score");

    // remove: warns about squares this person confirmed for others, cascades both ways
    assert.equal(Number((await as("authenticated", ADMIN, () => q("select admin_player_impact($1) as n", [Z.player_id])))[0].n), 1);
    const rm = await as("authenticated", ADMIN, () => rpc("admin_remove_player", [Z.player_id]));
    assert.deepEqual(rm, { removed: true, squares_lost_by_others: 1 });
    await as("authenticated", ADMIN, async () => { await expectErr("PLAYER_NOT_FOUND", rpc("admin_remove_player", [Z.player_id])); });
    assert.equal((await lbOf(s4.id))?.correct, 1);
    await expectErr("INVALID_TOKEN", as("anon", null, () => rpc("player_poll", [Z.player_token])));
    const rm2 = await as("authenticated", ADMIN, () => rpc("admin_remove_player", [Y.player_id]));
    assert.equal(rm2.squares_lost_by_others, 1);
    assert.equal(Number((await q("select count(*) as n from claims where player_id=$1 or coworker_id=$1", [Y.player_id]))[0].n), 0);
    const re = await join("Zed", "zed4@example.com", s4.code as string);
    assert.ok(re.player_token);
    ok("admin_remove_player cascades, reports lost squares, invalidates the token, allows rejoin");
  }

  // ---- Item 5: Manage admins ----
  {
    const NEWBIE = "00000000-0000-0000-0000-0000000000c3";
    await q("insert into auth.users(id, email) values ($1, 'New.Person@Example.com')", [NEWBIE]);
    await q("update auth.users set email='admin@example.com' where id=$1", [ADMIN]);
    await as("authenticated", OTHER_USER, async () => {
      await expectErr("NOT_ADMIN", q("select * from admin_list()"));
      await expectErr("NOT_ADMIN", rpc("admin_add", ["new.person@example.com"]));
      await expectErr("NOT_ADMIN", rpc("admin_remove", [ADMIN]));
    });
    await expectErr("permission denied", as("anon", null, () => q("select * from admin_list()")));
    await as("authenticated", ADMIN, async () => {
      const l = await q("select * from admin_list()");
      assert.equal(l.length, 1);
      assert.deepEqual([l[0].user_id, l[0].email, l[0].is_me], [ADMIN, "admin@example.com", true]);
      assert.ok(l[0].added_at);
      await expectErr("USER_NOT_FOUND", rpc("admin_add", ["nobody@example.com"]));
      assert.equal((await rpc("admin_add", ["  NEW.person@example.com "])).added, true);
      assert.equal((await rpc("admin_add", ["new.person@example.com"])).added, false);
      assert.equal((await q("select * from admin_list()")).length, 2);
      await expectErr("CANNOT_REMOVE_SELF", rpc("admin_remove", [ADMIN]));
    });
    await as("authenticated", NEWBIE, async () => {
      assert.equal((await q("select is_admin() as a"))[0].a, true);
      assert.equal((await rpc("admin_remove", [ADMIN])).removed, true);
      // NEWBIE is now the only admin: removing anyone else is refused
      await expectErr("LAST_ADMIN", rpc("admin_remove", [ADMIN]));
    });
    // restore
    await q("insert into admins(user_id) values ($1)", [ADMIN]);
    await q("delete from admins where user_id=$1", [NEWBIE]);
    await as("authenticated", ADMIN, async () => {
      await expectErr("CANNOT_REMOVE_SELF", rpc("admin_remove", [ADMIN]));
    });
    ok("admin_list / admin_add / admin_remove incl. USER_NOT_FOUND, CANNOT_REMOVE_SELF, no-op re-add");
  }

  // ---- Item 14: Post-event stats ----
  {
    const st = await as("authenticated", ADMIN, async () => {
      const r = await rpc("create_session", ["Stats game", 600, "correct_then_time", false, 3, 5, prompts]);
      await rpc("start_session", [r.id]);
      return r;
    });
    const stId = st.id as string;
    const [SP, SQ, SR, SS] = [
      await join("Pia", "pia@example.com", st.code as string),
      await join("Quin", "quin@example.com", st.code as string),
      await join("Rae", "rae@example.com", st.code as string),
      await join("Sid", "sid@example.com", st.code as string),
    ];
    const ins = (a: Joined, b: Joined, cell: number, status: string) =>
      q("insert into claims(session_id, player_id, coworker_id, cell_index, status, resolved_at) values ($1,$2,$3,$4,$5,now())", [stId, a.player_id, b.player_id, cell, status]);
    await ins(SP, SQ, 0, "confirmed");
    await ins(SQ, SP, 0, "confirmed"); // same pair, other direction
    await ins(SP, SR, 1, "confirmed");
    await ins(SR, SQ, 0, "rejected");
    await ins(SS, SP, 0, "expired");
    await q("update players set submitted_at = (select started_at from sessions where id=$1) + interval '100 seconds' where id=$2", [stId, SP.player_id]);
    const stats = (await as("authenticated", ADMIN, () => rpc("session_stats", [stId]))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual(stats.participation, { joined: 4, active: 2, submitted: 1, full_cards: 0, participation_rate: 0.5 });
    assert.equal(stats.squares.confirmed, 3);
    assert.equal(stats.squares.rejected, 1);
    assert.equal(stats.squares.expired, 1);
    assert.equal(Number(stats.squares.avg_confirmed_per_player), 0.75);
    assert.equal(stats.squares.distribution.length, 7);
    assert.deepEqual(stats.squares.distribution.map((d: Row) => d.players), [2, 2, 0, 0, 0, 0, 0]);
    assert.equal(Number(stats.timing.avg_elapsed_seconds), 100);
    assert.equal(stats.timing.fastest_full_card, null);
    assert.equal(stats.prompts.length, 24);
    assert.equal(stats.prompts.reduce((n: number, p: Row) => n + Number(p.found_count), 0), 3);
    assert.equal(stats.prompts.reduce((n: number, p: Row) => n + Number(p.rejected_count), 0), 1);
    assert.ok(stats.prompts.every((p: Row, i: number, a: Row[]) => i === 0 || Number(a[i - 1].found_count) >= Number(p.found_count)));
    assert.equal(stats.people.total_unique_connections, 2);
    assert.deepEqual(stats.people.top_connected[0], { name: "Pia", connections: 2, times_confirmed_for_others: 1 });
    assert.equal(stats.people.top_connected.length, 3);
    // empty session
    const empty = await as("authenticated", ADMIN, async () => {
      const r = await rpc("create_session", ["Empty", 600, "correct_then_time", false, 3, 5, prompts]);
      return (await rpc("session_stats", [r.id])) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    });
    assert.equal(empty.participation.joined, 0);
    assert.equal(empty.participation.participation_rate, 0);
    assert.deepEqual(empty.people.top_connected, []);
    await as("anon", null, () => expectErr("permission denied", rpc("session_stats", [stId])));
    await as("authenticated", OTHER_USER, () => expectErr("NOT_ADMIN", rpc("session_stats", [stId])));
    ok("session_stats: counts, distribution, connections, empty session, admin-only");
  }

  // ---- Item 2: allowed email domains ----
  {
    const mk = (domains: string[]) =>
      as("authenticated", ADMIN, () =>
        rpc("create_session", ["Dom", 300, "correct_then_time", false, 1, 1, prompts, domains]),
      );
    await as("authenticated", ADMIN, async () => {
      await expectErr("INVALID_INPUT", rpc("create_session", ["Dom", 300, "correct_then_time", false, 1, 1, prompts, ["@acme.com"]]));
      await expectErr("INVALID_INPUT", rpc("create_session", ["Dom", 300, "correct_then_time", false, 1, 1, prompts, ["localhost"]]));
    });
    const d = await mk([" ACME.com ", "acme.co.uk", "acme.com"]);
    const stored = await q("select allowed_email_domains as d from sessions where id=$1", [d.id]);
    assert.deepEqual(stored[0].d, ["acme.com", "acme.co.uk"]);
    const dj = (email: string) => as("anon", null, () => rpc("join_session", [d.code, "Dom User", email]));
    await expectErr("EMAIL_DOMAIN", dj("x@gmail.com"));
    await expectErr("EMAIL_DOMAIN", dj("x@mail.acme.com"));
    await expectErr("EMAIL_DOMAIN", dj("x@evilacme.com"));
    await expectErr("EMAIL_DOMAIN", dj("x@acme.com.evil.io"));
    await dj("Ok@ACME.com");
    await dj("ok2@acme.co.uk");
    const info = await as("anon", null, () => rpc("session_join_info", [String(d.code).toLowerCase()]));
    assert.deepEqual(info, { name: "Dom", status: "lobby", allowed_email_domains: ["acme.com", "acme.co.uk"] });
    await expectErr("SESSION_NOT_FOUND", as("anon", null, () => rpc("session_join_info", ["ZZZZZZ"])));
    const open = await as("authenticated", ADMIN, () => rpc("create_session", ["Open", 300, "correct_then_time", false, 1, 1, prompts]));
    const oi = await as("anon", null, () => rpc("session_join_info", [open.code]));
    assert.deepEqual(oi.allowed_email_domains, []);
    await as("anon", null, () => rpc("join_session", [open.code, "Anyone", "any@gmail.com"]));
    ok("allowed email domains: normalized, exact-match enforced, join info, empty = any");
  }

  // ---- Item 3: edit a session before it starts ----
  {
    const sess3 = await as("authenticated", ADMIN, () => rpc("create_session", ["Edit me", 300, "correct_then_time", false, 1, 1, prompts]));
    const E = await as("anon", null, () => rpc("join_session", [sess3.code, "Eve", "eve@example.com"]) as unknown as Promise<Joined>);
    const idsBefore = await q("select id, position from session_prompts where session_id=$1 order by position", [sess3.id]);
    const boardBefore = await q("select cell_index, prompt_id from boards where player_id=$1 order by 1", [E.player_id]);
    const newPrompts = prompts.map((p) => `${p} edited`);
    const upd = (id: unknown, ps = newPrompts, name = "Renamed") =>
      rpc("update_session", [id, name, 900, "full_card_fastest", true, 2, 3, ["acme.com"], ps]);
    await as("anon", null, async () => {
      await expectErr("permission denied", upd(sess3.id));
    });
    await as("authenticated", OTHER_USER, async () => {
      await expectErr("NOT_ADMIN", upd(sess3.id));
    });
    await as("authenticated", ADMIN, async () => {
      await expectErr("SESSION_NOT_FOUND", upd(crypto.randomUUID()));
      await expectErr("PROMPT_COUNT", upd(sess3.id, newPrompts.slice(0, 23)));
      await expectErr("INVALID_INPUT", upd(sess3.id, [...newPrompts.slice(0, 23), " "]));
      await expectErr("INVALID_INPUT", upd(sess3.id, newPrompts, " "));
      await expectErr("INVALID_INPUT", rpc("update_session", [sess3.id, "X", 10, "correct_then_time", false, 1, 1, [], newPrompts]));
      await expectErr("INVALID_INPUT", rpc("update_session", [sess3.id, "X", 300, "correct_then_time", false, 1, 1, ["bad@domain"], newPrompts]));
      await upd(sess3.id);
    });
    const row = (await q("select name, duration_seconds, ranking_mode::text as m, require_full_card, winners_count, max_squares_per_coworker, allowed_email_domains from sessions where id=$1", [sess3.id]))[0];
    assert.deepEqual(row, { name: "Renamed", duration_seconds: 900, m: "full_card_fastest", require_full_card: true, winners_count: 2, max_squares_per_coworker: 3, allowed_email_domains: ["acme.com"] });
    const idsAfter = await q("select id, position, text from session_prompts where session_id=$1 order by position", [sess3.id]);
    assert.deepEqual(idsAfter.map((r) => [r.id, r.position]), idsBefore.map((r) => [r.id, r.position]));
    assert.ok(idsAfter.every((r) => String(r.text).endsWith(" edited")));
    const boardAfter = await q("select cell_index, prompt_id from boards where player_id=$1 order by 1", [E.player_id]);
    assert.deepEqual(boardAfter, boardBefore);
    const ep = await as("anon", null, () => rpc("player_poll", [E.player_token]) as unknown as Promise<Poll>);
    assert.ok(ep.board.filter((c) => !c.is_free).every((c) => String(c.prompt).endsWith(" edited")));
    await as("authenticated", ADMIN, async () => {
      await rpc("start_session", [sess3.id]);
      await expectErr("ALREADY_STARTED", upd(sess3.id));
      await rpc("end_session", [sess3.id]);
      await expectErr("ALREADY_STARTED", upd(sess3.id));
    });
    ok("update_session: lobby only, prompts updated in place (ids and boards stay valid), validation");
  }

  // ---- Item 6: bingo lines mode ----
  {
    // SQL lines table: 12 lines, FREE excluded, cells valid
    const ln = await q("select idx, cells, need from _bingo_lines() order by idx");
    assert.equal(ln.length, 12);
    assert.deepEqual(ln[2].cells, [10, 11, 13, 14]);
    assert.deepEqual(ln[10].cells, [0, 6, 18, 24]);
    assert.deepEqual(ln[11].cells, [4, 8, 16, 20]);
    assert.ok(ln.every((l) => (l.cells as number[]).length === l.need));

    await as("authenticated", ADMIN, async () => {
      await expectErr("INVALID_INPUT", rpc("create_session", ["L", 300, "lines", false, 1, 1, prompts, [], 0]));
      await expectErr("INVALID_INPUT", rpc("create_session", ["L", 300, "lines", false, 1, 1, prompts, [], 13]));
    });
    const ls = await as("authenticated", ADMIN, () => rpc("create_session", ["Lines", 600, "lines", true, 3, 24, prompts, [], 2]));
    assert.equal((await q("select lines_to_win, ranking_mode::text as m from sessions where id=$1", [ls.id]))[0].lines_to_win, 2);
    await q("update sessions set status='live', started_at = now() - interval '300 seconds', ends_at = now() + interval '300 seconds' where id=$1", [ls.id]);
    const lj: Joined[] = [];
    for (let i = 0; i < 9; i++) {
      lj.push(await as("anon", null, () => rpc("join_session", [ls.code, `L${i}`, `l${i}@example.com`]) as unknown as Promise<Joined>));
    }
    const lids = lj.map((x) => x.player_id);
    for (let i = 0; i < lids.length; i++) {
      await q("update players set joined_at = now() - make_interval(secs => $1) where id=$2", [100 - i, lids[i]]);
    }
    // confirmed squares: [player index, cell, seconds after start]
    const spec: [number, number[], number][] = [
      [0, [0, 1, 2, 3, 4], 100], // row0 at 100
      [0, [5, 6, 7, 8, 9], 200], // row1 at 200  -> 2 lines, reach 200
      [1, [0, 1, 2, 3, 4], 60],
      [1, [5, 6, 7, 8, 9], 150], // reach 150
      [2, [0, 1, 2, 3, 4], 90],
      [2, [5, 6, 7, 8, 9], 150], // reach 150: ties with player 1
      [3, [0, 1, 2, 3, 4], 20], // only 1 line
      [4, [10, 11, 13, 14], 120], // middle row, FREE counts
      [4, [2, 7, 17, 22], 180], // column 2 -> 2 lines, reach 180
      [5, [0, 1, 2, 3], 30], // 4 of row0: no line
      [7, [0, 6, 18, 24], 40], // main diagonal
      [7, [4, 8, 16, 20], 50], // anti diagonal -> 2 lines, reach 50
    ];
    for (const [pi, cells, sec] of spec) {
      for (const cell of cells) {
        await q(
          "insert into claims(session_id, player_id, coworker_id, cell_index, status, created_at, resolved_at) values ($1,$2,$3,$4,'confirmed', (select started_at from sessions where id=$1) + make_interval(secs => $5 - 1), (select started_at from sessions where id=$1) + make_interval(secs => $5))",
          [ls.id, lids[pi], lids[(pi + 1) % lids.length], cell, sec],
        );
      }
    }
    await q("update players set submitted_at = (select started_at from sessions where id=$1) + make_interval(secs => 100) where id in ($2, $3)", [ls.id, lids[5], lids[6]]);

    const lcfgs = [
      { lines: 2, winners: 3, full: true },
      { lines: 2, winners: 1, full: false },
      { lines: 1, winners: 5, full: false },
      { lines: 3, winners: 2, full: false },
    ];
    for (const c of lcfgs) {
      await q("update sessions set lines_to_win=$1, winners_count=$2, require_full_card=$3 where id=$4", [c.lines, c.winners, c.full, ls.id]);
      const lb = await as("authenticated", ADMIN, () => q("select * from session_leaderboard($1)", [ls.id]));
      const st = (await q("select extract(epoch from started_at)*1000 as st from sessions where id=$1", [ls.id]))[0];
      const pl = await q("select id, extract(epoch from joined_at)*1000 as j, extract(epoch from submitted_at)*1000 as sub from players where session_id=$1", [ls.id]);
      const cl = await q("select player_id, cell_index, extract(epoch from resolved_at)*1000 as r from claims where session_id=$1 and status='confirmed'", [ls.id]);
      const expected = rankPlayers(
        pl.map((p) => {
          const mine = cl.filter((x) => x.player_id === p.id).map((x) => ({ cell: x.cell_index as number, resolvedAt: Number(x.r) }));
          return { id: p.id as string, correct: mine.length, joinedAt: Number(p.j), submittedAt: p.sub === null ? null : Number(p.sub), confirmed: mine };
        }),
        { mode: "lines", requireFullCard: c.full, winnersCount: c.winners, startedAt: Number(st.st), durationSeconds: 600, linesToWin: c.lines },
      );
      assert.equal(lb.length, expected.length);
      lb.forEach((row, i) => {
        const e = expected[i];
        const label = `lines(${c.lines}, winners ${c.winners}): row ${i}`;
        assert.equal(row.player_id, e.id, `${label} id`);
        assert.equal(row.correct, e.correct, `${label} correct`);
        assert.equal(row.lines, e.lines, `${label} lines`);
        assert.ok(Math.abs(Number(row.elapsed_seconds) - e.elapsedSeconds) < 0.01, `${label} elapsed`);
        assert.equal(row.eligible, e.eligible, `${label} eligible`);
        assert.equal(row.rank, e.rank, `${label} rank`);
        assert.equal(row.is_winner, e.isWinner, `${label} winner`);
        assert.equal(row.prize_rank, e.prizeRank, `${label} prize`);
        if (e.reachSeconds === null) assert.equal(row.reach_seconds, null, `${label} reach null`);
        else assert.ok(Math.abs(Number(row.reach_seconds) - e.reachSeconds) < 0.01, `${label} reach`);
      });
      ok(`leaderboard matches lib/ranking.ts (lines, lines_to_win=${c.lines}, winners=${c.winners})`);
    }
    // concrete expectations for lines_to_win = 2: P7 (50s) > P1 = P2 (150s, tie) > P4 (180s) > P0 (200s)
    await q("update sessions set lines_to_win=2, winners_count=3, require_full_card=false where id=$1", [ls.id]);
    const lb2 = await as("authenticated", ADMIN, () => q("select player_id, rank, lines, is_winner, round(reach_seconds::numeric) as r from session_leaderboard($1)", [ls.id]));
    assert.deepEqual(lb2.slice(0, 5).map((r) => r.player_id), [lids[7], lids[1], lids[2], lids[4], lids[0]]);
    assert.deepEqual(lb2.slice(0, 5).map((r) => r.rank), [1, 2, 2, 4, 5]);
    assert.deepEqual(lb2.slice(0, 5).map((r) => Number(r.r)), [50, 150, 150, 180, 200]);
    assert.deepEqual(lb2.slice(0, 5).map((r) => r.is_winner), [true, true, true, false, false]);
    // non-eligible follow: P3 (1 line) first
    assert.equal(lb2[5].player_id, lids[3]);
    assert.equal(lb2[5].lines, 1);
    ok("lines mode: reach time ordering, ties share rank, FREE centre counts, non-eligible by lines");

    // poll: me.lines, session fields, result after end
    const lp = await as("anon", null, () => rpc("player_poll", [lj[4].player_token]) as unknown as Promise<Poll>);
    assert.equal(lp.me.lines, 2);
    assert.equal(lp.session.ranking_mode, "lines");
    assert.equal(lp.session.lines_to_win, 2);
    const lp3 = await as("anon", null, () => rpc("player_poll", [lj[5].player_token]) as unknown as Promise<Poll>);
    assert.equal(lp3.me.lines, 0);
    await q("update sessions set ends_at = now() - interval '1 second' where id=$1", [ls.id]);
    const lend = await as("anon", null, () => rpc("player_poll", [lj[7].player_token]) as unknown as Promise<Poll>);
    assert.equal(lend.result!.lines, 2);
    assert.equal(Math.round(Number(lend.result!.reach_seconds)), 50);
    assert.equal(lend.result!.rank, 1);
    ok("player_poll: me.lines, session.ranking_mode/lines_to_win, result.lines/reach_seconds");
  }

  // ---- Item 7: extend time and pause/resume ----
  {
    const admin = <T,>(fn: () => Promise<T>) => as("authenticated", ADMIN, fn);
    const anon = <T,>(fn: () => Promise<T>) => as("anon", null, fn);
    const ps = await admin(() => rpc("create_session", ["Pausable", 600, "correct_then_time", false, 3, 24, prompts]));
    const psid = ps.id as string;
    const pj = async (n: string) => anon(() => rpc("join_session", [ps.code, n, `${n.toLowerCase()}@pause.io`]) as unknown as Promise<Joined>);
    const [X, Y, Z] = [await pj("Xp"), await pj("Yp"), await pj("Zp")];
    const ppoll = (j: Joined) => anon(() => rpc("player_poll", [j.player_token]) as unknown as Promise<Poll>);
    const pclaim = (j: Joined, cell: number, to: Joined) => anon(() => rpc("create_claim", [j.player_token, cell, to.player_code]));

    // lobby: pause/extend not possible
    await admin(async () => {
      await expectErr("NOT_LIVE", rpc("pause_session", [psid]));
      await expectErr("NOT_LIVE", rpc("extend_session", [psid, 60]));
      await expectErr("NOT_PAUSED", rpc("resume_session", [psid]));
      await rpc("start_session", [psid]);
    });
    const p0 = await ppoll(X);
    assert.equal(p0.session.paused, false);
    assert.equal(p0.session.paused_at, null);

    // permissions
    await anon(async () => {
      await expectErr("permission denied", rpc("pause_session", [psid]));
      await expectErr("permission denied", rpc("resume_session", [psid]));
      await expectErr("permission denied", rpc("extend_session", [psid, 60]));
      await expectErr("permission denied", q("select * from session_pauses"));
    });
    await as("authenticated", OTHER_USER, async () => {
      await expectErr("NOT_ADMIN", rpc("pause_session", [psid]));
      await expectErr("NOT_ADMIN", rpc("extend_session", [psid, 60]));
    });

    // extend
    const endsBefore = new Date(String((await q("select ends_at from sessions where id=$1", [psid]))[0].ends_at)).getTime();
    await admin(async () => {
      await expectErr("INVALID_INPUT", rpc("extend_session", [psid, 0]));
      await expectErr("INVALID_INPUT", rpc("extend_session", [psid, 3601]));
      await rpc("extend_session", [psid, 120]);
    });
    const ext = (await q("select duration_seconds, ends_at from sessions where id=$1", [psid]))[0];
    assert.equal(ext.duration_seconds, 720);
    assert.equal(new Date(String(ext.ends_at)).getTime() - endsBefore, 120_000);
    ok("extend_session: bounds, adds to ends_at and duration_seconds, admin only");

    // a pending claim, then pause
    const pend = await pclaim(X, 0, Y);
    await admin(async () => {
      await rpc("pause_session", [psid]);
      await expectErr("ALREADY_PAUSED", rpc("pause_session", [psid]));
    });
    const pp = await ppoll(X);
    assert.equal(pp.session.status, "live");
    assert.equal(pp.session.paused, true);
    assert.ok(pp.session.paused_at);
    assert.equal(((await ppoll(Y)).incoming.length), 1);
    await expectErr("PAUSED", pclaim(X, 1, Z));
    await expectErr("PAUSED", anon(() => rpc("respond_claim", [Y.player_token, pend.claim_id, true])));
    await expectErr("PAUSED", anon(() => rpc("cancel_claim", [X.player_token, pend.claim_id])));
    // submit is still allowed while paused
    await anon(() => rpc("submit_board", [Z.player_token]));
    assert.ok((await ppoll(Z)).me.submitted_at);
    // admin list exposes paused_at
    const lst = await admin(() => q("select id, paused_at from admin_sessions()"));
    assert.ok(lst.find((r) => r.id === psid)?.paused_at);
    ok("pause_session: poll paused/paused_at, claims blocked with PAUSED, submit allowed");

    // a paused session is never ended by time, and can still be extended
    await q("update sessions set ends_at = now() - interval '50 seconds' where id=$1", [psid]);
    assert.equal((await ppoll(X)).session.status, "live");
    await expectErr("PAUSED", pclaim(X, 1, Z));
    await admin(() => rpc("extend_session", [psid, 10])); // extending a paused session is allowed
    // resume pushes ends_at forward by the pause length
    await q("update session_pauses set started_at = now() - interval '100 seconds' where session_id=$1 and ended_at is null", [psid]);
    await q("update sessions set paused_at = now() - interval '100 seconds', ends_at = now() + interval '30 seconds' where id=$1", [psid]);
    await admin(() => rpc("resume_session", [psid]));
    const after = (await q("select paused_at, extract(epoch from (ends_at - now())) as left from sessions where id=$1", [psid]))[0];
    assert.equal(after.paused_at, null);
    assert.ok(Math.abs(Number(after.left) - 130) < 2, `ends_at pushed by pause length (${after.left})`);
    assert.equal((await q("select count(*)::int as n from session_pauses where session_id=$1 and ended_at is null", [psid]))[0].n, 0);
    await admin(async () => {
      await expectErr("NOT_PAUSED", rpc("resume_session", [psid]));
    });
    assert.equal((await ppoll(X)).session.paused, false);
    // claims work again; the claim made before the pause is still pending
    await anon(() => rpc("respond_claim", [Y.player_token, pend.claim_id, true]));
    await pclaim(X, 1, Z);
    ok("resume_session: ends_at pushed forward, paused flag cleared, claims allowed again");

    // pending claims do not age while paused
    await q("update sessions set started_at = now() - interval '600 seconds', ends_at = now() + interval '300 seconds' where id=$1", [psid]);
    const old1 = await pclaim(X, 2, Z);
    const old2 = await pclaim(Y, 3, Z);
    await q("update claims set created_at = now() - interval '270 seconds' where id in ($1, $2)", [old1.claim_id, old2.claim_id]);
    // both are 4.5 minutes old, but most of that time was paused, so neither has expired
    await q("insert into session_pauses(session_id, started_at, ended_at) values ($1, now() - interval '240 seconds', now() - interval '60 seconds')", [psid]);
    assert.equal((await anon(() => rpc("respond_claim", [Z.player_token, old1.claim_id, true]))).status, "confirmed");
    assert.equal((await anon(() => rpc("respond_claim", [Z.player_token, old2.claim_id, true]))).status, "confirmed");
    const ctl = await admin(() => rpc("create_session", ["Control", 600, "correct_then_time", false, 3, 24, prompts]));
    await admin(() => rpc("start_session", [ctl.id]));
    const cj = async (n: string) => anon(() => rpc("join_session", [ctl.code, n, `${n.toLowerCase()}@ctl.io`]) as unknown as Promise<Joined>);
    const [CA, CB] = [await cj("Ca"), await cj("Cb")];
    const cc = await pclaim(CA, 0, CB);
    await q("update claims set created_at = now() - interval '270 seconds' where id=$1", [cc.claim_id]);
    await expectErr("CLAIM_NOT_PENDING", anon(() => rpc("respond_claim", [CB.player_token, cc.claim_id, true])));
    ok("pending claims do not age during pauses (control session without a pause expires)");

    // elapsed excludes pauses: leaderboard matches lib/ranking.ts with pauses (two modes)
    const es = await admin(() => rpc("create_session", ["Elapsed", 600, "correct_then_time", false, 3, 24, prompts]));
    await q("update sessions set status='live', started_at = now() - interval '400 seconds', ends_at = now() + interval '200 seconds' where id=$1", [es.id]);
    const ej: Joined[] = [];
    for (let i = 0; i < 4; i++) ej.push(await anon(() => rpc("join_session", [es.code, `E${i}`, `e${i}@elapsed.io`]) as unknown as Promise<Joined>));
    const eids = ej.map((x) => x.player_id);
    for (let i = 0; i < eids.length; i++) await q("update players set joined_at = now() - make_interval(secs => $1) where id=$2", [100 - i, eids[i]]);
    // pause from +100s to +200s, plus a still-open pause from +350s
    await q("insert into session_pauses(session_id, started_at, ended_at) values ($1, (select started_at from sessions where id=$1) + interval '100 seconds', (select started_at from sessions where id=$1) + interval '200 seconds')", [es.id]);
    await q("insert into session_pauses(session_id, started_at) values ($1, (select started_at from sessions where id=$1) + interval '350 seconds')", [es.id]);
    await q("update sessions set paused_at = started_at + interval '350 seconds' where id=$1", [es.id]);
    const espec: [number, number[], number, number | null][] = [
      [0, [0, 1, 2, 3, 4], 260, 250], // row 0 at +260 (after first pause), submitted +250
      [1, [0, 1, 2, 3, 4], 150, 150], // inside the pause
      [2, [0, 1, 2, 3, 4], 380, null], // during the open pause window
      [3, [5, 6, 7, 8], 120, 130],
    ];
    for (const [pi, cells, sec, sub] of espec) {
      for (const cell of cells) {
        await q(
          "insert into claims(session_id, player_id, coworker_id, cell_index, status, created_at, resolved_at) values ($1,$2,$3,$4,'confirmed', (select started_at from sessions where id=$1), (select started_at from sessions where id=$1) + make_interval(secs => $5))",
          [es.id, eids[pi], eids[(pi + 1) % 4], cell, sec],
        );
      }
      if (sub !== null) await q("update players set submitted_at = (select started_at from sessions where id=$1) + make_interval(secs => $2) where id=$3", [es.id, sub, eids[pi]]);
    }
    for (const mode of ["correct_then_time", "lines"] as const) {
      await q("update sessions set ranking_mode=$1, lines_to_win=1 where id=$2", [mode, es.id]);
      const lb = await admin(() => q("select * from session_leaderboard($1)", [es.id]));
      const st = Number((await q("select extract(epoch from started_at)*1000 as st from sessions where id=$1", [es.id]))[0].st);
      const pauses = (await q("select extract(epoch from started_at)*1000 as s, extract(epoch from ended_at)*1000 as e from session_pauses where session_id=$1", [es.id])).map((r) => ({ start: Number(r.s), end: r.e === null ? null : Number(r.e) }));
      const pl = await q("select id, extract(epoch from joined_at)*1000 as j, extract(epoch from submitted_at)*1000 as sub from players where session_id=$1", [es.id]);
      const cl = await q("select player_id, cell_index, extract(epoch from resolved_at)*1000 as r from claims where session_id=$1 and status='confirmed'", [es.id]);
      const expected = rankPlayers(
        pl.map((p) => {
          const mine = cl.filter((x) => x.player_id === p.id).map((x) => ({ cell: x.cell_index as number, resolvedAt: Number(x.r) }));
          return { id: p.id as string, correct: mine.length, joinedAt: Number(p.j), submittedAt: p.sub === null ? null : Number(p.sub), confirmed: mine };
        }),
        { mode, requireFullCard: false, winnersCount: 3, startedAt: st, durationSeconds: 600, linesToWin: 1, pauses },
      );
      lb.forEach((row, i) => {
        const e = expected[i];
        const label = `pause parity ${mode} row ${i}`;
        assert.equal(row.player_id, e.id, `${label} id`);
        assert.ok(Math.abs(Number(row.elapsed_seconds) - e.elapsedSeconds) < 0.01, `${label} elapsed ${row.elapsed_seconds} vs ${e.elapsedSeconds}`);
        assert.equal(row.rank, e.rank, `${label} rank`);
        assert.equal(row.eligible, e.eligible, `${label} eligible`);
        if (e.reachSeconds === null) assert.equal(row.reach_seconds, null, `${label} reach null`);
        else assert.ok(Math.abs(Number(row.reach_seconds) - e.reachSeconds) < 0.01, `${label} reach`);
      });
      if (mode === "correct_then_time") {
        // E0 submitted at +250 with 100s paused -> 150; E1 at +150 with 50s paused -> 100
        const byId = new Map(lb.map((r) => [r.player_id, r]));
        assert.ok(Math.abs(Number(byId.get(eids[0])!.elapsed_seconds) - 150) < 0.01);
        assert.ok(Math.abs(Number(byId.get(eids[1])!.elapsed_seconds) - 100) < 0.01);
      } else {
        // E2 completes row 0 at +380: 100s + 30s (open pause since +350) paused -> 250
        const r2 = lb.find((r) => r.player_id === eids[2])!;
        assert.ok(Math.abs(Number(r2.reach_seconds) - 250) < 0.01, `reach ${r2.reach_seconds}`);
      }
      ok(`elapsed and reach time exclude pauses; leaderboard matches lib/ranking.ts (${mode})`);
    }

    // end_session while paused closes the pause
    await admin(async () => {
      await rpc("end_session", [es.id]);
    });
    const ended = (await q("select status::text as st, paused_at, (select count(*)::int from session_pauses where session_id=$1 and ended_at is null) as open from sessions where id=$1", [es.id]))[0];
    assert.deepEqual(ended, { st: "ended", paused_at: null, open: 0 });
    assert.equal((await ppoll(ej[0])).session.status, "ended");
    assert.equal((await ppoll(ej[0])).session.paused, false);
    await admin(async () => {
      await expectErr("SESSION_ENDED", rpc("pause_session", [es.id]));
      await expectErr("SESSION_ENDED", rpc("extend_session", [es.id, 60]));
      await expectErr("SESSION_ENDED", rpc("resume_session", [es.id]));
    });
    ok("end_session while paused closes the pause; pause/extend/resume rejected after the end");
  }

  console.log(`\n${passed} checks passed`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
