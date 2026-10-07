<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes, APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Spike, notes for agents

Ranked **individual** Spikeball/roundnet league derived from **2v2** games. Mobile-first PWA
built to the "Spike v2" design (lime `#CBFB4F` on near-black `#0C0E10`, max-width 480px).

## Working here (read first)
The repo is public and `main` deploys straight to the live league, so:
- **Never touch production.** Everything runs against the Docker Postgres from `npm run db:up`,
  with `.env.local` copied from `.env.example`. Don't ask for, read, print or guess real secrets
  or a production `DATABASE_URL`. The shared Claude Code settings (`.claude/settings.json`) deny
  reading `.env*` files other than `.env.example`, `vercel env pull` and `drizzle-kit push`, and
  the scripts that write fake data refuse any database that isn't local (`scripts/local-only.mjs`).
- **Before saying done:** `npx tsc --noEmit -p .`, `npm test`, `npm run build`. CI
  (`.github/workflows/ci.yml`) runs the same three on every pull request, with no secrets.
- **Changes land by pull request.** `main` is protected: CI must pass and the code owner must
  approve (`.github/CODEOWNERS`), and pull requests are squash-merged. Never push to `main` or
  force-push a branch someone else is using.
- **Schema changes:** edit `src/db/schema.ts`, run `npm run db:generate`, commit the generated
  migration and apply it locally with `npm run db:migrate`. Never edit a merged migration, and
  never `drizzle-kit push`. After merge, `.github/workflows/migrate.yml` applies it to production
  once the owner approves the run.
- **No AI attribution** in commits or pull requests: no `Co-Authored-By` trailers for tools, no
  session links, no "Generated with" footers. `.claude/settings.json` turns them off for Claude Code.
- **Keep this file true.** When a change makes something here wrong, fix it in the same pull
  request; this file is how the next agent learns why the code is the way it is. The public
  history starts at a single initial commit, so there's no older `git log` to dig the reasons
  out of — they have to live here.

## Architecture (current, v2)
- **Single-page client app.** `src/app/page.tsx` (server component) loads data via
  `getLeagueData()` and renders `<SpikeApp>` (`src/components/SpikeApp.tsx`), which holds ALL
  screen state and switches screens client-side (ladder / matchmaker / log / stats / profile
  / me) with a bottom nav. Screens that grew past a screenful live in `src/components/spike/`
  as dumb props-in components (`Profile`, `Stats`, `GameHistory`, `ActivityHeatmap`,
  `RatingExplainer`, `RaceChart`, `WhatIf`, `HeadToHead`), all built on the shared kit in
  `spike/ui.tsx` (palette `C`, motion vocabulary, `Avatar`/`SegTabs`/`Disclosure`/`ChipRow`/
  `ResultRow`/icons). The rest are still `render*()` closures inside SpikeApp — they close over
  a dozen pieces of state each and there are no component tests, so extracting them buys nothing.
- **Stats is the league's page**, four tabs: Records / Leaders / Race / Scoring. The plain-English "how scoring works" reference (`spike/ScoringGuide.tsx`) is deliberately buried behind the ⓘ in the ladder header, not on a main screen. Four is the
  ceiling — five needs shrunken type to fit a 360px phone, so a new section goes inside a tab,
  not beside it. **Scoring holds three stacked sections**: what-if, head-to-head, then the
  rating explainer. The first two are the "explore a hypothetical" tools and the third is the
  reference for both. They live here rather than on a profile because neither is about one
  person: what-if picks any four players (not you and three others), and head-to-head picks any
  two. `HeadToHead` is one component with controlled a/b selection, so the section and the sheet
  that a profile's best-partner / nemesis cards open are the same comparison — don't grow a
  second one. A full-page `Disclosure` index was tried here instead of tabs and rejected; keep
  the tabs.
- **A match is the atomic event.** Persisted as `matches` + 2 `match_teams` + 4 `match_players`.
  `getLeagueData` loads ALL confirmed matches; seasons are windows on that list, not a column.
- **Seasons are windows on the match list, started in code** (`src/lib/season.ts`). A season
  begins at London midnight on the `day` of an entry in `SEASON_STARTS`, and its `to` is what its
  games are played to (Season 1: 21; Season 2: 17) — a reviewed one-line PR, never a
  button, because the sign-in code is shared and anyone signed in can do what an admin can. A
  day still in the future does nothing until it arrives (`seasonsAt(now)`, server clock), so a
  season can ship ahead of time. Season 1 is everything before Season 2. **Game length is a
  season rule**: every match carries `to`, set on the server from its season (`targetAt`), and
  it's read by the win chance (`gameWinProb(p, to)` — a race to 17 gives the underdog more
  chance than one to 21), par (`parScoreline(share, to)`), validation (`validWinBy2(a, b, to)`,
  checked in `logMatch` against the season now and in `editMatchScore` against the game's own
  season, so a Season 1 score still has to reach 21), the Log form and what-if (tap the winner →
  `to`–0) and the matchmaker's time estimate (`gameMinutes`). The fit only reads points, so a game
  to 17 simply carries less evidence than one to 21; ratings stay comparable across seasons and
  in All time, and nothing about game length is stored in the database. A match falls in
  whichever season it was played in, so adding, moving or removing a start can't lose or
  double-count a game; the ratings just recompute. Each view — Season N or All time — is
  `computeStandings(players, scopeMatches(...))`: a new season is a fresh league (back on `START`,
  `PROV_N` games to place, last season forgotten) and All time is the whole history, never reset.
  Seasons after the first are `fresh` (`isFresh`, `StandingsOpts.fresh`, `fitSkills(…, fresh)`):
  every player is a founder, so *everyone* starts on `START` — nobody is new to the league, so
  the late-joiner prior would only penalise whoever missed the first night. A season view shows
  that season's own rating and tier, and nothing from All time: All time's numbers appear only
  when All time is on screen. (Seasons first shipped showing `rating − START` as "+40", with the
  all-time rating greyed beside it and all-time tiers; people just wanted to see their score, and
  an all-time tier beside a season rating reads as the wrong tier.) The opening season keeps the league's own priors, so its
  table is exactly All time as it stood (and it borrows All time's ledger). A ledger records
  whether it was built `fresh`, and `computeStandings` never reuses one built on the other priors:
  match sigs alone can't tell them apart, and a season whose games equal All time's (an empty
  Season 1) would otherwise inherit All time's numbers. A game's season is when it was *logged* (the server stamps `playedAt`; clients can't set
  it), so a session running past midnight on a season's first day splits. A finished season's
  table is `final`: nobody rests in it (`computeStandings({ final })`, `rankRanges(…, final)`),
  every player who placed keeps a number, and those who didn't read "Didn't place". With only one
  season the app *is* All time (no picker, no season copy). Chose a clean
  slate over a soft reset (seeding each season from All time) because a season is meant to be a
  new race; the cost is 50/50 odds on a season's first night *in the season view*, honest for a
  fit that knows nothing yet. **The matchmaker always uses All time** ("longest since they
  partnered" is league history; balance wants the best-informed skills), and so does its
  reasoning on screen. The season switch (`spike/SeasonPicker.tsx`; only once a second season
  exists, not on Log or the matchmaker) IS the header title on Ladder, Stats and All games
  ("● Season 2 ⌄") and a small pill beside the title on a profile or Me; headers are one line,
  no subtitles, with the ⓘ as its own button. It picks the view; `State.scope` is `"current"` by default, so a
  rollover carries everyone onto the new season. A season's ladder lists only people who've played
  in it (a banner explains the empty first night). A logged game's reward screen always shows the
  season in progress, and logging puts the app back on it, so the rank shown is the one on the
  ladder they land on; it reads the seasons off the phone's clock, so a page left open over a
  season start still counts the game where the server will (and a page brought back on a new day
  refreshes itself). Season badges say so: "Placing" not "Rookie" for a returning veteran, peaks
  are season highs and only once placed. The match sheet reads the
  viewed scope, or the game's own season when it isn't in it (tonight's games, from the matchmaker,
  while a finished season is on screen).
- **Pickers fold away people resting 28+ days** (`splitRoster`, read from All time): sign-in, the
  matchmaker's who's-here chips and the Log chips show who's played lately (or never, i.e. just
  added) and hide the rest behind "+N more" — anyone tapped in or on a team always shows.
- **Only 9 tables:** `players`, `matches`, `match_teams`, `match_players`, `availability`,
  `session_plans`, `session_games`, `rating_cache`, `rate_limits`. The old seasons /
  rating_snapshots / badges / points / disputes tables were dropped (migration 0002); the two
  session tables arrived in 0003, `rating_cache` in 0004, `rate_limits` in 0005 (see Auth; also
  derived and short-lived, so truncating it only resets the counts). `rating_cache` is DERIVED —
  truncating it is always safe, and the app
  runs (just slower on a cold start) if it doesn't exist yet.
- **The matchmaker is a persisted schedule for one day**, not a list of suggestions. One
  `session_plans` row per day (roster + round count) with `session_games` rows per round/court.
  A game's `match_id` is what crosses it off — non-null means played, and `ON DELETE SET NULL`
  means deleting a match un-crosses its slot for free. Generated server-side
  (`generateSessionPlan`) so every phone sees the same plan and it can't reshuffle on re-render.
  Re-planning freezes every round up to and including the last one anything was logged in, and a
  frozen round keeps exactly the games it had even if the court count has since grown. The whole
  read-decide-rewrite runs in one transaction with `SELECT … FOR UPDATE` on the plan and its
  games — reading first and writing after left a window where a concurrent Clear or logged score
  could strand a plan starting at round 4, or delete a game that had just been crossed off.
  The **day always comes from the server**, never the client: a tab left open past midnight would
  otherwise write a plan under yesterday's date, where nothing can read it.
  Crossing a game off matches on both **teams**, not just the set of four players — with four
  present, every round holds the same faces in one of only three splits, so matching the foursome
  alone crossed off the wrong round and then rendered its score reversed.
  A **Copy** button on the plan header dumps it as plain text for the group chat (`planText`,
  pure): one `A & B vs. C & D` line per game, courts labelled only when more than one runs at
  once, sitters and played scores included. Guests get it too — it only reads the plan.
- **Ratings are a whole-history fit, recomputed after every game** (`src/lib/rating.ts`, the
  model; `src/lib/league.ts`, everything built on it). Every player has a skill per day they
  played; a game is scored on its **points**, not just the win — team A's expected point share
  is Φ((skillA0+skillA1−skillB0−skillB1)/S) and the scoreline is the observation. Skills drift
  day to day (random walk, `DRIFT` 0.5 μ per √day), founders start on a fixed prior, late joiners on a prior whose mean is
  itself fitted from how earlier late joiners turned out. The rating is the MAP fit to ALL games
  at once, so **who logged first, how often you play and when you joined cannot bias it** —
  shuffling the games within a night changes nothing to the fit (the ladder adds the win top-up
  on top, which does depend on log order; see below). Display `disp(μ) = 800 + 80·(μ − 25)`:
  everyone starts on 800, the top sits ~1200, and a newcomer is about average so half the league
  sits below the start by construction. It replaced an incremental TrueSkill-lite that paid ~+7
  a game for turning up and predicted games worse (forward log-loss 0.541 → 0.502); the review
  that chose it is reproducible with `npx tsx --env-file=.env.local scripts/rating-backtest.ts`.
  **Fair here means: predicts the next game best (out-of-sample log-loss), order-free, no volume
  bias, bounded single-game influence, calibrated odds.** Re-tune constants against that script,
  never by feel — every "obvious" fix tried (K-floors, weakest-link teams, shielding veterans
  from newcomers, beating the spread) predicted worse.
- **The ledger telescopes.** `computeStandings` fits every prefix of the match list (warm-started,
  ~120 ms cold for 121 games) and defines each game's delta as `fit(games ≤ i) − fit(games < i)`,
  plus any win top-up (`held`, below), so `ratingBefore + delta === ratingAfter` exactly, past deltas never change, and
  `start + Σwon + Σlost + Σrevalued === rating` exactly (`explainRating`). A game you weren't in
  can move you — someone else's result revalues yours — recorded as a `ripple` (usually 0–2
  points, max ~20), never hidden.
- **Ratings are computed once per change, not per request** (`src/lib/ratingCache.ts`, pure and
  tested; `src/lib/ratingLedger.ts`, the server glue). Each view's ledger + rank ranges is cached
  under a fingerprint of the model constants and, on Vercel, the commit (`RATING_KEY`), and of that
  view's match sigs (plus whether it's final): first in process memory, then in `rating_cache`
  (keyed `(scope, model)`, so two deploys sharing a database never overwrite each other; other
  builds' rows are pruned after a fortnight), written back with `after()`. A deploy therefore
  recomputes once, then every cold start reads. A cold serverless start reads
  one row per view instead of refitting the history (~0.5 s → ~2 ms at 121 games; ~5 s → ~20 ms at
  310). A stale ledger is *extended* (computeStandings reuses every matching prefix), so a logged
  game costs one warm fit for All time and one for its season; a finished season never refits. A
  row read back from the DB must pass `ledgerStillFits` (re-fit its last game under this build's
  model) before it's trusted — and one failure discards every row — so a change to rating.ts can't
  serve old numbers even if nobody touches `RATING_KEY`. The opening season's games are a prefix of
  All time's, so it borrows that ledger (`ledger: null` on the wire) instead of fitting or shipping
  a copy. Ledgers travel and rest *packed* (`packLedger`: ids once, not per snapshot — lossless,
  ~2× smaller). The rank ranges (200 bootstrap refits per view) are what a logged game still costs
  on the server (~0.4 s now, behind the reward screen): if that grows, defer them with `after()`
  before touching anything else. `LeagueData.ratings[scopeKey]` goes to the client, which unpacks a
  view's ledger into `computeStandings` lazily (`standingsFor`, only views something asks for) and
  pays one warm fit for an optimistic match. Never call `computeStandings` on the client without
  the ledger.
- **A win always pays at least `winFloor(gf, ga)`; losses can still gain.** The floor is
  `WIN_MIN` (+2) for a win by two plus a point per `WIN_PER` (3) further points of margin
  (21–19 → +2, 21–13 → +4, 21–0 → +8), so even under par the scoreline still counts. The fit
  itself drops a 95% favourite who wins 21–19 (par ~21–12), and it must keep doing so, because
  that's what keeps odds, par and the matchmaker honest. The ladder tops such a win up to the floor
  instead, and the top-up is **kept for good**: `MatchEntry.held` per game, `PlayerStat.held` in
  total, and `rating === disp(mu) + held`. This was a product call (people like getting points for
  a win, and the score should still make it better), made knowing the costs: on the real league
  ~20% of veterans' wins come in under par, the regulars who win most sit ~15–75 above their fit, and
  because which of a night's wins came in under par depends on log order, only the *fit* is
  order-free, not the top-up (reversing a night's log order moves a few players by up to ~15 and
  can swap two neighbours). Weighting the win inside the fit instead (bonus rallies for the winner)
  was tried and rejected: it inflates skill gaps, wrecks the odds and still leaves ~9% of wins
  negative. Payback schemes (repaying the top-up from later gains) were offered and declined as
  too confusing. `explainDelta` flags `underPar` (the fit alone went negative) so the UI can say
  "Won, but under par" next to the small +. `rankRanges` takes `held` so the range is read off
  the ladder's number.
- **Placement:** `PROV_N = 8`. Below it a player is `provisional` ("placing"): rated, listed in
  `cs.placing`, **no `rank`**. `cs.ranked` = 8+ games, `cs.played` = ranked + placing — use
  `played` wherever you mean "has played". Bootstrapping the real league showed ranks still ±3
  places at 9–11 games, so profiles show a 5–95% **rank range** (`rankRanges`, server-side, 200
  refits, seeded) as "likely 6th–11th".
- **Team strength is the SUM of the two partners.** Max ("strongest carries") and min ("weakest
  link") were both tested on the real league and predict markedly worse. The in-between, for the
  "they just serve at the weaker one" argument, is a model constant, `GAP` (`teamSkill`:
  `a + b − GAP·|a − b|`, so the weaker partner counts for `(1+GAP)/2`), tested by section 6 of
  the backtest (`--gap 0.1,0.2` also prints the ladder at those GAPs, via `StandingsOpts.model`).
  At GAP 0 the fit runs exactly the arithmetic it did before GAP existed: bit-identical, same
  speed. On the real league (129 games, 6 Oct 2026) **GAP 0, the plain sum, predicted best**:
  every step up predicted a little worse (point log-loss +0.01×10⁻³ at 0.1 rising to +1.7×10⁻³ at
  0.6), and the more lopsided pair scored on par (+0.05 points per 100 rating points of extra gap,
  ±0.23). Section 6's verdict is one test fixed in advance: does GAP 0.1 beat GAP 0 by more than
  its noise, on 30+ scored games. In simulated leagues shaped like this one it never fired without
  targeting (0/75). At ~130 games it fired for moderate targeting (weaker partner 65%) in 5/30 and
  1/30 leagues at the two noise levels tried, and for strong (75%) in 16/30 and 3/30. At the lower
  noise only (5 leagues per size), it caught strong targeting every time from ~250 games and
  moderate 4 in 5 by ~1000. A result like the real one turned up in 6–7 of 10 leagues with no
  targeting and 0–3 in 10 with it, so it leans against targeting without ruling out a modest
  amount. **A section-6 win is not enough to turn it on.** The gap term isn't concave for any
  GAP > 0. A level pair that lost splits into two mirror-image fits once GAP passes roughly
  20 ÷ (the rating points they sit below the start): ~0.18 for the test's pair, ~0.05 for a pair at
  420, so not even 0.1 is clear of it. In simulated 128-game leagues a fresh fit disagreed with the
  chained one somewhere in the history in 12 of 180 at 0.2, 121 at 0.4 and 165 at 0.6, by up to
  ~360 pts (on the final fit alone: 1, 4 and 26). Ratings would hang on fitting order and split
  partners with identical records. With a GAP the solver can also stop short (`Fit.converged`);
  section 6(b) shows both per row, after every game up to ~170 games and spot-checked beyond (it
  says which). It would need a different formulation first (a much smoother
  gap, or a prior against splitting partners), then a check that chained, fresh and randomly
  started fits agree on the real league. If it ever goes above 0, the matchmaker's balance
  (`genSession`'s `muGap`) and the plan's "Lopsided" line in SpikeApp must switch from summing μ
  to `teamSkill`.
- **Players carry an `active` flag.** Inactive (removed) players still resolve everywhere for history
  (computeStandings gets ALL players) but are filtered out of pickers and the ladder.
- **Every derivation lives in `league.ts`, never in a component.** Badges, day buckets, the
  activity grid, records, leaderboards, head-to-head (`headToHead` for the record and the
  games, `comparePlayers` for the side-by-side career table — including which side leads each
  line), the rating explainer and the what-if preview are all pure functions with tests. There are NO component tests, so anything with
  logic in it belongs in the engine where it can be pinned.
- **Resting (dormant) players give up their rank number, nothing else.** `isDormant` (28 days)
  measures against `cs.lastMatchAt`, NOT `Date.now()` — deterministic in tests, identical across
  SSR/hydration, and a league-wide quiet month can't empty the ladder. `computeStandings` skips
  them when numbering `rank` (they stay in `cs.ranked`, rated and placed), so the ladder reads
  1, 2, 3… with no gap; `rankRanges` leaves them out too. One game back and the rank returns.
  Anything rendering `#${p.rank}` must handle a placed player with no rank. Never filter the
  input to `computeStandings`.
- **Anything bucketed by calendar day uses `LEAGUE_TZ`** (`dayKey`/`dayBuckets`/`activityGrid`),
  never the host offset: the server runs UTC and the phones run London, so a late BST game
  would otherwise land on a different heatmap cell in SSR than after hydration. `now` comes
  from the server on `LeagueData` for the same reason.
- **`previewMatch` (what-if) replays the whole league** with the hypothetical appended, passing
  `cs.ledger` so it costs one warm fit and is identical to the real ladder by construction. A test
  pins that equivalence.
- **`explainDelta(entry, partner?)` answers "why did they get more than me?"** — per PLAYER, not
  per match. Three levers: **par going in** (the scoreline the league expected, from `expShare`),
  **result vs par** (the points above or below it — this is what moves you), and **how well the
  league knows you** (`gamesBefore`: fewer games, bigger steps). Same par and result for both
  team-mates, so the team's credit is shared and **ratings don't decide the split: whoever the
  league is less sure about moves further, win or lose.** People keep asking why a higher-rated
  partner took more off a win, so the `compare` line states that rule outright, then the first
  reason that applies: fewer games (`gamesBefore`, ~80% of cases), more days off (`daysOff`), or
  the other partner already pinned down by earlier games that day (`earlierToday`). It stays
  `null` below a 1.15× ratio. It changes no rating; every number is arithmetic over what
  `computeStandings` recorded.
- **`DRIFT` was 1.0 until the Tim/Euan 21–7 (22 Sept).** At 1.0 two days off left a 72-game
  regular as loose as an 18-game newcomer, so the veteran took +92 to the newcomer's +81 and swings
  of ±100 for one game were normal. At 0.5, on the real league: forward log-loss 0.500 → 0.502
  and Brier 0.1650 → 0.1652 (noise at 121 games), veterans' median swing 16 → 9, newcomers'
  31 → 26, the more-established partner takes more off a win 28% → 16% of the time, and that game
  reads Tim +41, Euan +50. The ladder compressed (Tim 1376 → 1172) with the order barely moved.
  Going lower (0.35, 0.25) predicts measurably worse and makes genuine improvement slow to show.

## Auth
- **Guest browsing by default** (no cookie). Sign in = the league's **shared code** (`SPIKE_PIN`,
  4–8 digits; dev falls back to `0000`, production refuses sign-in without a valid one), then
  pick your name. Gates Log/Me/Matchmaker. `LeagueData.pinLength` is all the client learns about
  the code: how many dots to draw.
- `src/app/actions/league.ts`: `verifyGroupPin` (the keypad) and `signIn` both check the code
  against the env in constant time (`src/lib/auth/pin.ts`). A session is a signed JWT cookie
  (`src/lib/auth/session.ts`): HS256 only, `iat`/`exp` required, 60 days, and production refuses
  an `AUTH_SECRET` under 32 characters or the `.env.example` one. Rotating `AUTH_SECRET` signs
  everyone out. Player rows still carry a scrypt hash of the code (`pin_hash`) so an older build
  can be rolled back to; nothing reads it.
- **Every try at a code is counted before it's checked.** `src/lib/auth/limits.ts` is the policy
  (pure, tested); `src/lib/auth/rateLimit.ts` counts in `rate_limits` with one atomic upsert per
  bucket, because serverless instances share no memory. Buckets are per keyed-hash IP (Vercel sets
  `x-forwarded-for` itself, so it can't be spoofed there) and league-wide, taken in that order: the
  league's only counts tries the IP's let through, so one IP can't lock everyone out, and a right
  code clears its IP's bucket and hands its try back to the league's. Checking first and counting
  after was a real race — twenty parallel guesses all read "0 so far" and all got checked. A
  refused try is never compared, and the keypad shows the server's reason (`pinError`), so
  "too many tries" never reads as "wrong code". Signed-in writes are capped per IP too
  (`logMatch`, `generateSessionPlan`), after the cheap checks and, for `logMatch`, after the
  idempotent-retry short-circuit, so re-sending a game that already saved always succeeds. If
  the table can't be reached, the limiter lets the try through and logs it.
- **Server actions are public endpoints:** anyone can call them with any arguments. Every argument
  is checked before use (`isUuid`, `isName`, a real calendar day inside the availability window,
  roster size and membership) — never assume the caller is this app's UI.
- **Admin is a second lock, not a role you can sign in as.** The shared code lets anyone pick an
  admin's name, so `requireAdmin()` needs an admin player AND a session unlocked with
  `SPIKE_ADMIN_CODE` (admins-only, 8+ characters, compared in constant time in
  `src/lib/auth/admin.ts`, rate-limited like the shared code, and a wrong guess costs 700 ms). `unlockAdmin` re-signs the session cookie
  with `adminUntil` (now + `ADMIN_HOURS`, 12), so it can't be forged or extended, and it ends on
  sign-out or signing in as anyone else. `LeagueData.adminUntil` tells the client; admin controls
  render only while it's set (`adminOn`), an admin who isn't unlocked gets the code field in their
  place, and a refused admin action refreshes so the controls lock to match. Every admin server
  action re-checks — never trust the client. Unset code = admin locked. Seasons don't go through
  this at all: they're started in code.

## Key files
- `src/lib/rating.ts`, the rating model: `fitSkills` (Newton + matrix-free CG, O(games) per step), `disp`, `gameWinProb`.
- `src/lib/league.ts`, THE engine on top of it: standings + ledger (and its packed form), explainers, badges, records, `splitRoster`, `genSession` scheduler (pure).
- `src/lib/season.ts`, `SEASON_STARTS` (how a season begins) and the scope helpers; `src/lib/ratingCache.ts`, which views need recomputing and how (pure).
- `src/lib/ratingLedger.ts`, the server-side memory + `rating_cache` layer over it; `src/lib/day.ts`, calendar-day helpers in `LEAGUE_TZ`.
- `scripts/rating-backtest.ts`, the fairness review as one command (read-only).
- `src/lib/leagueData.ts`, server loader (DB → players + matches + seasons + per-view ratings + today's plan + session + `now`).
- `src/components/SpikeApp.tsx`, the shell: all state, the sheets, and the remaining screens.
- `src/components/spike/ui.tsx`, the shared kit — import `C`/`Avatar` from here, never redeclare.
- `src/components/spike/`, the extracted screens and widgets (see Architecture above).
- `src/components/spike/WhyDelta.tsx`, the per-player breakdown behind every ± in a match sheet.
- `src/db/schema.ts`, Drizzle schema (9 tables, lean).
- `src/lib/auth/`: `pin.ts` (the shared code), `session.ts` (cookies), `admin.ts` (the admin code),
  `limits.ts` + `rateLimit.ts` (rate limits). `src/app/actions/league.ts` holds every server action.
- `.github/workflows/ci.yml` (typecheck, tests, build on every pull request; no secrets) and
  `migrate.yml` (applies migrations to production after merge, behind the `production-db`
  environment's approval). `vercel.json` gives Dependabot's branches no preview deploy, so their
  code never runs with a deployment's secrets.

## The session scheduler (`genSession`)
`genSession(ids, cs, { rounds, played })` → `SessionPlan`. `floor(N/4)` games run at once.
Priorities, and they are a strict hierarchy, not weights to be retuned casually:
1. **Rotation is a hard constraint** (`pickSitters`): sitters always come from those who've sat
   least and never from anyone who sat last round. That *proves* `max(sat) − min(sat) <= 1`
   after every round, so an even spread of games can't be traded away for anything below.
2. **Pairings that haven't played in the longest time**, measured across LEAGUE history
   (`cs.pair[].lastIdx`) — not just tonight. Opponents count at ~1/3 the weight (`cs.foe`).
   Every term is normalised to [0,1] against a roster-scaled horizon and quantised onto a
   0.05 grid, so the ordering doesn't drift as the league grows.
3. **Reusing a partnership already played tonight** (`W_SEEN`) is weighted above the whole of
   (2) combined, so an unused pairing always wins — repeats appear only when the pigeonhole
   forces them. Dropping this weight makes the same matchup recur round after round.
4. **Team balance** is the only term below the grid: it breaks ties and nothing else. Expect
   plenty of "Lopsided" games — that's the stated priority order working, not a bug.
Deterministic (no `Math.random`, `ids` sorted internally). It runs once per generate inside a
server action, not on render — but it is synchronous, so it holds the event loop: ~90ms at 10
players, ~1.1s at 18, ~3s at 18 × 20 rounds.

Three things in the court search are load-bearing and easy to break:
- **Every court must contain the lowest-numbered player still waiting.** That's what makes each
  set of disjoint games reachable exactly once, so there's nothing to deduplicate. Ordering
  courts by their position in the candidate table does that too — but it leaves partial
  assignments *unextendable*, and once the beam prunes to the cheapest few, all of them can be
  dead ends. That shipped once: with three or more courts and real history, `genSession`
  silently returned fewer rounds than asked for, and at 16 or 20 players usually none at all.
- **Pruning sorts on score alone and relies on `Array#sort` being stable** — generation order
  is already canonical, so that's deterministic. Comparing matchup-key strings instead rebuilds
  a string per comparison, and quantised scores tie constantly, so it dominated the runtime.
- **`SITTER_CAP` bounds how many benches get scored** (they're all equally fair, but there can
  be hundreds), sampled at an even stride so it isn't always the alphabetically-first players
  benched in round one. `MAX_PLAYERS` is 31 because the search addresses players with a bitmask.

Any change here must be tested against a league **with history**: an empty league ties every
novelty term, which flattens the cost landscape and hides exactly this class of bug.

## Conventions
- **Players are managed in-app** (Me → Manage players, admin only, once unlocked): `addPlayer`/`renamePlayer`
  server actions. `seed.ts` only bootstraps an initial roster (Tim is admin). Players can't be
  deleted (the `active` flag still exists in the schema for history, but nothing toggles it off).
  Avatars are coloured initials (two-letter for the Bens).
- **Tapping any result opens its sheet** (Recent, All games, Tonight, chemistry): everyone sees the
  pre-game **win chance** (each team's `winProb` from the ratings going in — computed pre-update in
  `computeStandings`, stored per player-match) and the per-player **rating impact** (the retrospective
  `disp` delta each player got from that game, read straight off `computeStandings`). Together they
  show the story — favourite vs upset. **Tapping a player's ± expands `WhyDelta`** (`s.whyId`, one
  open at a time): the odds, the margin, how settled that player is, the skill/certainty split, and
  the team-mate comparison. The number and the name are SEPARATE buttons in one row — the name still
  opens the profile, and nesting one button in the other is invalid HTML that swallows the inner tap
  on iOS. It's suppressed while an admin has unsaved score edits, since the deltas on screen are then
  stale. Admins additionally get score edit / delete controls in the same
  sheet once unlocked (`editMatchScore`/`deleteMatch`) — edits never auto-apply, they need Save. Edits/deletes hit
  the DB then reload, so optimistic local matches are dropped (and local matches aren't editable).
- **There is exactly one way to log a match**, and it's the Log screen. The matchmaker used to have
  its own inline stepper + `quickLog`; tapping an unplayed plan row now prefills the Log form and
  navigates there (`logPlanGame`), carrying `logPlanGameId` so `crossOffPlan` claims that exact slot.
  Editing the line-up by hand clears it, so a hand-picked foursome can't claim someone else's game.
  The Log screen also shows the next unplayed round as one-tap "Next up" cards, and orders the chips
  with whoever's at the court first — that's what keeps a growing roster usable.
- **Scores: tap the winner, then slide.** Tapping a team sets `to`–0 (the season's game length: 17
  from Season 2); the `ScoreRail` in `spike/ui.tsx` sets the loser's score, and the winner tracks
  `max(to, loser + 2)`. Win-by-2 is therefore
  *structural* — the form can't reach an invalid score, so `validWinBy2` never fires on it. The rail
  reads its value back from `scrollLeft`, so the browser's own momentum does the work; a `settling`
  ref stops programmatic `scrollTo` being mistaken for a flick, and a touch on the rail clears that
  guard so a flick mid-animation isn't swallowed. **A deliberate pick (tapping a tick, releasing a
  drag) calls `onChange` itself** — relying on the scroll handler only worked when the smooth scroll
  happened to outlast the guard, so short hops silently moved the rail and not the score. Mouse drag
  is hand-rolled because `overflow-x` gives a desktop pointer nothing; touch keeps native momentum.
  Pull-to-refresh skips gestures starting on `.spk-rail`, or it `preventDefault`s the slide away.
- **Press-and-hold controls need `.spk-noselect` and SVG glyphs, not `+`/`−` text.** A text node
  gives a long press something to select and pops iOS's Copy/Look Up callout mid-hold. Inline
  `userSelect` is not enough: React doesn't vendor-prefix, Safari only took unprefixed `user-select`
  from 17, and `-webkit-touch-callout` has no unprefixed form — so it has to be a stylesheet rule.
  `preventDefault` on `pointerdown` can't help; Safari decides that gesture off the touch stream.
- **Logging is meant to feel like a reward.** `submitMatch` builds a `LogResult` snapshot from the
  two `computeStandings` replays it already has (before, and with the optimistic match appended) —
  rating delta, tier change, a `computeBadges` diff **keyed on badge `id`** (labels carry counts
  that move), streak, partner run, tonight's tally. No server round-trip and no new columns.
  `ratingBefore`/`ratingAfter` come off the player-match entry itself, and ranks off
  `PlayerStat.rank` — the field the ladder renders — so the "#4" here can't drift from the one
  they'll see. **One phone gets passed round a court**, so it shows the
  whole game: the result in names, the pre-game odds, and a card per player with their rating
  counting up, their ladder move and *one* line on what was notable for them. Sized to fit a phone
  screen without scrolling; a single X dismisses it (back to the plan if the game came off one,
  else a fresh form). Keep it that way — it's a celebration, not an explainer. Nothing on it
  describes how ratings work, and the only prose is about what these four just did. Confetti fires
  only when the person logging is in the match and won.
  It also never blocks: the maths is local, so it renders immediately and the write settles behind
  it. Both a rejection **and a throw** revert to the filled-in form with a toast — losing a typed
  result to bad court WiFi is the one failure that isn't acceptable here.
- Drizzle: edit `schema.ts`, then `npm run db:generate && npm run db:migrate`.
- DB driver is `postgres` (postgres.js) for BOTH local and Neon, don't add the Neon serverless driver.
- Styling is inline-style objects matching the design's exact hex (palette `C` from `spike/ui.tsx`).
- **Fonts are self-hosted** (`src/app/fonts`, loaded with `next/font/local`): the same Latin
  variable Geist and Geist Mono files Google Fonts serves, with their OFL licence beside them. Don't
  go back to `next/font/google`. It downloads the fonts at build time, and Turbopack fails the whole
  build whenever Google answers with `/l/font?kit=…&skey=…` URLs (vercel/next.js#99114), which
  turned CI red on unrelated pull requests and can stop a production deploy.
- DB scripts run with `tsx --env-file=.env.local`. Any script that writes made-up data calls
  `assertLocalDatabase()` (`scripts/local-only.mjs`) first; `db:demo` deletes every game.

## Tests
`npm test`, league-engine fixtures (W/L, PF/PA, chemistry ordering, opponent history), the
rating model (order invariance incl. within-day reordering, warm-start ≡ cold fit, stale ledger
not trusted, points matter, placement gate, rank ranges, tiers, and `GAP`: a lopsided pair scores
below its sum, GAP 0 is exactly the sum, the fit sits flat on the posterior `expectedShare`
defines, a large enough GAP makes the fit non-unique, and a ledger is never reused across models, either way), the
derivation layer (per-match provenance reconciling `ratingBefore + delta === ratingAfter` and
`start + won + lost + revalued === rating`,
`lastPlayed`/dormancy, day buckets and the activity grid, badges, records, leaderboards,
head-to-head — including the against/alongside split and `comparePlayers` awarding each line
to whoever is genuinely ahead on it — and `previewMatch` proving it matches a full replay),
`explainDelta` (the three levers, `underPar`, and the partner comparison naming the side the
league knows less), seasons (London-midnight starts across DST, future starts inert, windows
partition the games, the opening season equals All time as it stood and reuses its ledger, a later
season starts afresh and ignores the last), the packed ledger (exact JSON round trip),
`ledgerStillFits` (rejects a ledger built under other maths), the rating cache (no work when
nothing changed, a new game touches only All time and its season, a different `RATING_KEY` is never
built on), `splitRoster`, the shared code and rate limits (`src/lib/auth/codes.test.ts`:
production refuses a missing or malformed code, exact constant-time matching, refusal windows,
the caps' arithmetic against a real night), plus the
`genSession` contract: shape/courts-by-headcount, the rotation guarantees (games AND sits within
1 of each other after *every* round, no back-to-back benching at any headcount), one test per
priority level above, determinism, and partial replan (frozen prefix, late arrival, departure).
When touching the scheduler, the two that matter most are "puts the pairings that haven't played
in the longest time first" and "still mixes up the session when the league already has history" —
they pin the behaviours that regressed during development.

## Not fully built (roadmap)
Live point-by-point mode, Rim-vs-Pocket disputes+voting, official WhatsApp Cloud API.

**Share the ladder was removed.** Nobody used it; the season pill took its place in the header.
The matchmaker's Copy (tonight's plan as text) is what still goes to the group chat.

**Tournaments were removed.** The bracket/americano generators and their screen were
ephemeral, never persisted and never used. They predate this repo's public history (the
maintainer's private archive has them), so ask before bringing the format back — don't
reintroduce them speculatively.

**Voice logging was removed** too — a Web Speech API prototype nobody used, whose BETA tab
cost vertical space on the most-used screen in the app.
