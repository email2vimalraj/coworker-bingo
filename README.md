# Coworker Bingo

A mobile-friendly "get to know your coworker" bingo for live events (450+ players), built for free tiers: Next.js 15 on Vercel Hobby, Supabase Free (Postgres, Auth for admins, Realtime for the admin dashboard only).

Players join a session by scanning a QR code, then fill squares by scanning coworkers who match a prompt. The coworker confirms on their own phone. Admins create sessions (time limit, ranking rules, winners), watch a live dashboard, and can delete sessions.

Players need no login: joining returns a secret `player_token` kept in localStorage, and every player action is a `SECURITY DEFINER` Postgres RPC called directly from the browser with the anon key. Phones poll `player_poll(token)` about every 3s.

## Setup

1. Create a free project at https://supabase.com.
2. In the SQL editor run, in order:
   - `supabase/migrations/0001_init.sql`
   - optionally `supabase/seed.sql` (a demo session with code `DEMO23`)
3. Create an admin user: Authentication > Users > Add user (email + password). Then in the SQL editor:

   ```sql
   insert into admins (user_id)
   select id from auth.users where email = 'you@example.com';
   ```

   Only users in `admins` can use admin RPCs and read tables (`is_admin()`).
4. Copy `.env.local.example` to `.env.local` and fill in the project URL and anon key (Project Settings > API) and `NEXT_PUBLIC_APP_URL` (e.g. `http://localhost:3000`, or your Vercel URL).
5. `npm install && npm run dev`

Camera scanning needs HTTPS (a Vercel preview URL or a tunnel); on localhost use the manual code box.

## Codes

- Session code: 6 chars, e.g. `K7PQ2X`. Player code: `XXX-XXX`. Alphabet excludes `0 O 1 I L`.
- `create_claim` accepts the coworker code case-insensitively, with or without the dash, or a full URL containing `c=<code>`. Parsing is done in SQL (`normalize_player_code`) and mirrored in `lib/codes.ts`, so the client can pass raw scanner output.
- QR content: `{origin}/play/{sessionCode}/scan?c={playerCode}`.

## RPCs

Player (anon): `join_session`, `player_poll`, `create_claim`, `respond_claim`, `cancel_claim`, `submit_board`.
Admin (authenticated + `is_admin()`): `create_session`, `start_session`, `end_session`, `session_leaderboard`. Deleting a session is a normal table delete (cascades).

Errors are raised as the exception message: `INVALID_INPUT`, `EMAIL_TAKEN`, `SESSION_NOT_FOUND`, `SESSION_ENDED`, `NOT_LIVE`, `TIME_UP`, `ALREADY_SUBMITTED`, `SELF_SCAN`, `COWORKER_NOT_FOUND`, `COWORKER_LIMIT`, `CELL_TAKEN`, `NOT_YOURS`, `INVALID_TOKEN`, `CLAIM_NOT_FOUND`, `CLAIM_NOT_PENDING`, `NOT_ADMIN`, `PROMPT_COUNT`, `ALREADY_STARTED`, `CODE_GENERATION_FAILED`.

## Ranking

See `lib/ranking.ts` (identical to the SQL `_leaderboard`): correct squares desc, then elapsed asc (non-submitters get the full duration); `full_card_fastest` ranks only 24/24 boards; `require_full_card` limits winners to 24/24; ties share a rank; `joined_at` is the final ordering tiebreak.

## Tests

```bash
npm test          # vitest: ranking and code helpers
npm run test:db   # runs the migration in PGlite (in-process Postgres) with a stubbed Supabase auth schema
npm run typecheck
npm run lint
```
