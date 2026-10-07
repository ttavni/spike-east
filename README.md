# Spike: a roundnet ladder

A ranked **individual** league for a group that plays **2v2** roundnet (Spikeball). Log a doubles
game and everyone's personal rating updates from the scoreline. It's a mobile-first installable
web app, built for one phone passed round a court.

## What it does
- **Ladder**: everyone ranked on one number, per season or all time. New players are "placing" for
  their first 8 games, and profiles show how sure the ladder is ("likely 6th–11th").
- **Log a game**: tap the winners, slide the losers' score, done. The reward screen shows each
  player's rating change, ladder move and one line on what was notable.
- **Matchmaker**: pick who's here and it plans the night: rotating sit-outs, pairings that haven't
  played together in longest first, then balanced teams. Every phone sees the same plan, and
  Copy pastes it into the group chat.
- **Stats**: records, leaderboards, a rating race, and "what if" and head-to-head tools.
- **Profiles**: rating history, streaks, badges, best partner and nemesis.
- **Seasons**: each season is a fresh race, while an all-time ladder keeps going underneath.

## How ratings work
Every game is scored on its **points**, not just the win: the model knows what scoreline it
expected (par), and beating or missing par is what moves you. Ratings are a fit to the *whole*
history at once, so the order games were logged, how often you play and when you joined don't
bias anyone. A win always pays something (+2 for a win by two, more for a bigger margin).
Everyone starts on 800; the top of the ladder sits around 1200.

The model, and why every choice in it was made, is written up in [AGENTS.md](AGENTS.md).
Constants are tuned against `scripts/rating-backtest.ts`, never by feel.

## Run it locally
You need Node 22 and Docker.

```bash
npm install
cp .env.example .env.local   # local-only values; nothing to change to get started
npm run db:up                # Postgres in Docker
npm run db:migrate           # create the tables
npm run db:seed              # a starter roster (sign-in code 0000 in dev)
npm run db:demo              # optional: a few weeks of made-up games
npm run dev                  # http://localhost:3000
```

The made-up-data scripts only run against a database on your machine.

| command | what |
|---|---|
| `npm run dev` | dev server |
| `npm test` | unit tests (the league engine, ratings, scheduler, auth limits) |
| `npx tsc --noEmit -p .` | typecheck |
| `npm run build` | production build |
| `npm run db:up` / `db:down` | start / stop local Postgres |
| `npm run db:generate` | write a migration from changes to `src/db/schema.ts` |
| `npm run db:migrate` | apply migrations to the database in `.env.local` |
| `npm run db:seed` | starter roster |
| `npm run db:demo` | replace local games with demo data |
| `npm run db:studio` | browse the database |

## Contributing
Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). If you use an AI coding agent,
it should read [AGENTS.md](AGENTS.md) first (Claude Code does automatically). To report a security
problem, don't open an issue: see [SECURITY.md](SECURITY.md).

## Signing in
Anyone can browse. To log games or plan a night, you sign in with the league's **shared code**
(`SPIKE_PIN`, 4–8 digits) and pick your name. Guesses are rate-limited per device and across the
whole league. Sessions are signed cookies (`AUTH_SECRET`).

Because the code is shared, anyone with it can pick any name, admins included. So admin powers
(fixing a score, deleting a game, adding or renaming players) need a second, admins-only code,
`SPIKE_ADMIN_CODE`, typed once on the Me screen. A phone stays unlocked for 12 hours, or until the
admin locks it, signs out or signs in as someone else. If it isn't set, admin stays locked.

## Starting a season
Seasons start in code, not in the app, so nobody can start one by accident. Add the day to
`SEASON_STARTS` in `src/lib/season.ts` and open a pull request:

```ts
export const SEASON_STARTS = [
  { day: "2026-10-06", to: 17 }, // Season 2: games to 17
  { day: "2027-01-05", to: 17 }, // Season 3
];
```

The season begins at midnight (London) on that day, so it can be merged ahead of time, and `to`
is what its games are played to (win by 2). Season 1 was played to 21. Nothing in the database
changes: games fall into whichever season they were played in, and moving or removing a date
recomputes everything.

## Running your own league
It runs on [Vercel](https://vercel.com) and [Neon](https://neon.tech) Postgres; both have free
tiers that comfortably fit a group this size.

1. Create a Neon project and copy its **pooled** connection string.
2. Import the repo into Vercel and set these variables, scoped to **Production** only:
   `DATABASE_URL`, `AUTH_SECRET` (`openssl rand -base64 32`), `SPIKE_PIN` (6–8 digits) and
   `SPIKE_ADMIN_CODE`. Give **Preview** deployments a Neon branch and secrets of their own, so
   code that hasn't been merged never touches the real league.
3. In GitHub, create an environment called `production-db` with yourself as a required reviewer,
   and add `DATABASE_URL` as its secret. The [DB migrate](.github/workflows/migrate.yml) workflow
   then applies migrations after each merge that changes the schema, once you approve it.
4. Run `npm run db:seed` once against the new database for a starter roster (edit the names in
   `src/db/seed.ts` first), then manage players in the app.

## Not built yet
Live point-by-point scoring · rim-vs-pocket dispute voting · official WhatsApp integration.

## License
[MIT](LICENSE)
