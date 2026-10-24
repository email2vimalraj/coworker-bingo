/**
 * Verifies supabase/migrations/0001_init.sql against an in-process Postgres (PGlite).
 * Supabase pieces are stubbed: auth.users, auth.uid(), roles anon/authenticated.
 * Run: npm run test:db
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join as pjoin } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { rankPlayers, type RankingMode } from "../lib/ranking";

const root = pjoin(__dirname, "..");
const db = new PGlite({ extensions: { citext } });

const STUB = `
create schema auth;
create table auth.users (id uuid primary key);
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
  await db.exec(readFileSync(pjoin(root, "supabase/migrations/0001_init.sql"), "utf8"));
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
    ["code", "duration_seconds", "ends_at", "max_squares_per_coworker", "name", "started_at", "status", "winners_count"],
  );
  assert.deepEqual(Object.keys(live.me).sort(), ["correct", "full_name", "id", "player_code", "submitted_at"]);
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
  assert.deepEqual(Object.keys(pended.result!).sort(), ["correct", "elapsed_seconds", "is_winner", "prize_rank", "rank"]);
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
    const adminFns = ["create_session(text,int,ranking_mode,boolean,int,int,text[])", "start_session(uuid)", "end_session(uuid)", "session_leaderboard(uuid)", "session_activity(uuid,int)", "server_now()", "_leaderboard(uuid)", "is_admin()"];
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

  console.log(`\n${passed} checks passed`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
