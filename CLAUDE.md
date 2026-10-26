# Coworker Bingo

"Get to know your coworker" bingo for live events of 450+ players. Players join by QR, scan coworkers' QR codes to fill a 5×5 board (24 prompts + FREE centre), and the scanned coworker confirms Yes/No on their own phone. Admins create timed sessions with ranking rules and watch a live dashboard.

Stack: Next.js 15 App Router + TypeScript + Tailwind (no component library), Supabase (Postgres, Auth for admins only, Realtime for admin screens only). Hosting target: Vercel Hobby + Supabase Free.

## Commands

```bash
npm run dev            # app on http://localhost:3000
npm run db:start       # local Supabase in Docker (applies migrations + seed; demo session DEMO23)
npm run local:admin    # admin@local.test / admin12345 (re-run after db:reset)
npm run db:reset       # wipe local DB, re-apply migrations + seed
npx supabase migration up   # apply new migration files without wiping data

npm run typecheck && npm run lint && npm test   # unit tests: lib/**/*.test.ts (vitest)
npm run test:db        # runs all migrations in PGlite with a stubbed auth schema, ~30 SQL checks
npm run e2e:local      # 39 checks against the running local Supabase (RPCs, RLS, realtime, delete)
npm run load-test -- --session DEMO23 --players 450 --minutes 2 [--poll-ms 1000]
```

Before calling a change done: typecheck, lint, `npm test`, `npm run test:db`; plus `npm run e2e:local` when SQL or RPC calls changed (needs `db:start`). `npm run build` needs the env vars from `.env.local` (git-ignored; local keys are the public Supabase defaults printed by `db:start`).

## Architecture

- **Players have no login.** `join_session` returns a secret `player_token` (stored in localStorage per session code, `lib/playerStorage.ts`). Every player action is a `SECURITY DEFINER` Postgres RPC called straight from the browser with the anon key (`lib/api.ts`). `anon` has no table privileges at all.
- **Players poll; they don't use websockets.** Supabase Free allows ~200 realtime connections, and events need 450+. `player_poll(token)` returns everything a phone needs (session, `server_now`, board, incoming confirmation requests, result) in one call. Intervals live in `lib/pollInterval.ts`: 1s while the player's QR is on screen (`usePollBoost()` in `MyQr`) or they have a pending claim, 3s in a live game or lobby, 10s after submit or end. Don't add per-player Realtime subscriptions.
- **Admins** sign in with Supabase Auth and must be in the `admins` table (`is_admin()`). `middleware.ts` protects `/admin/*`. Admin screens use Realtime `postgres_changes` on `players`, `claims` and `sessions`, plus a 10s fallback refresh (`lib/useSessionDashboard.ts`).
- **Timers** are computed on the client from `ends_at` plus a server clock offset (`server_now`), see `lib/useCountdown.ts`. The server is the authority: RPCs reject actions after `ends_at` (`TIME_UP`), and the effective status treats a live session past `ends_at` as ended.
- **Routes:**
  - `app/join/[code]`, then `app/play/[code]/` (board, `scan`, `me`). All play pages are wrapped by `components/PlayerProvider.tsx`, which handles polling and the confirmation sheet.
  - Admin pages are under `app/admin/(protected)/`. The projector view is `app/admin/sessions/[id]/present` (outside the admin header, with its own guard).

## Rules and gotchas

- **Migrations:** `supabase/migrations/` is the source of truth for RPC names, argument names (all prefixed `p_`) and error codes. Add new numbered files (`0003_...sql`) and never edit applied ones. Local and hosted DBs already ran 0001–0002, and the files aren't idempotent. `test:db` loads every file in order.
- **Player tokens:** admins have column-level `select` on `players` that excludes `player_token`. Never return a token from any RPC except `join_session`. So PostgREST `select("*")` or `players(count)` embeds on `players` fail with "permission denied". Use an admin RPC instead (see `admin_sessions()` in 0002).
- **Ranking rules** exist twice and must stay identical: `lib/ranking.ts` and `session_leaderboard()` in SQL. `test:db` checks the two agree.
  - Order: correct desc, then elapsed asc, then `joined_at`.
  - Elapsed is `submitted_at − started_at`, or the full duration if the player never submitted.
  - Two modes: `correct_then_time` and `full_card_fastest`.
  - `require_full_card` limits winners to 24/24 boards.
  - A player needs at least 1 confirmed square to be eligible.
  - Ties share a rank.
- **Error codes:** RPC errors are raised as plain codes (`EMAIL_TAKEN`, `COWORKER_LIMIT`, `TIME_UP`, …). Map every new code to friendly text in `lib/errors.ts`.
- **Codes:**
  - Session codes are 6 characters. Player codes are `XXX-XXX`.
  - Both use an alphabet without 0, O, 1, I or L.
  - A scanned value may be a raw code or a full QR URL with `?c=`. `normalize_player_code` in SQL and `lib/codes.ts` both accept either.
- **Concurrency:** claim RPCs lock the scanner's player row first, then the claim. Keep that order in any new RPC, or two requests can deadlock.
- **Tests:** vitest has no `@/` alias, so test files and anything they import use relative paths. Keep logic you want to test out of files that import the Supabase client.
- **Realtime warm-up:** after `SUBSCRIBED`, `postgres_changes` needs a few seconds before events flow. Tests must wait (`e2e-local.ts` waits 6s).
- **Mobile first:** layouts must work at 375px wide. Tap targets need to be at least 44px (`min-h-11`), inputs at least 16px (`text-base`) so iOS doesn't zoom, and bottom sheets need safe-area padding. The camera scanner needs HTTPS, so on localhost test with the copy-paste player code.
- **Free-plan limits:** keep player traffic on Supabase RPCs, not Vercel functions, to stay within Vercel Hobby. Re-run the load test on the hosted project after any change to polling or `player_poll`.

## Agents (`.claude/agents/`)

- `implementer` (Sonnet): default for coding tasks. Runs the full check suite before reporting.
- `db-reviewer` (read-only): run it after any migration, RPC or ranking change, before committing or deploying.
