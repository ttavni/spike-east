# Spike, Design Brief (functionality only)

> **Historical.** This is the brief the original design was made from. The app has moved on
> since (sign-in is a shared code then your name, scores are tap-the-winner-and-slide, sharing the
> ladder was dropped, seasons and the matchmaker's plans were added), so read it for intent, not
> as a spec. The code and [AGENTS.md](AGENTS.md) describe what the app does now.

A ranked **individual** league for friends who play **2v2 roundnet** (Spikeball). Mobile-first,
installable PWA used **courtside on phones**. All visual/brand decisions are yours, this brief
only describes what each screen must do.

## Core idea
Players play 2v2, but the league ranks **individuals**. Logging one doubles match updates everyone's
personal rating. The app should make logging frictionless and make the standings, rivalries, and
partnerships fun to check between games.

## Users & access
- Small fixed roster (~8), attendance varies night to night.
- Sign in by **picking your name + 4-digit PIN**. No email.

## Screens & functionality

**1. Login**
- Grid of player names to pick from → numeric PIN entry → signed in.

**2. The Ladder (home)**
- Ranked list of players (1st…last) with: position, name/avatar, current rating (a number),
  win–loss record, recent "form" (last 5 results), and a streak indicator.
- Top few positions should read as a podium.
- Players with few games are flagged "provisional"; players with no games shown separately at the bottom.
- A way to share the standings to a chat (WhatsApp / share sheet).

**3. Log a Match** (the most-used screen, optimise for speed, one-handed)
- Assign 4 present players into Team A and Team B (2 each).
- Set each team's score with large +/− steppers (no keyboard).
- Submit → confirmation → ratings update.

**4. Player Profile**
- Header: name/avatar, rank, provisional state.
- Stat tiles: rating, games played, win %, current streak.
- Rating-over-time line chart.
- Best partner and nemesis callouts.
- Earned badges.
- List of recent matches (result, partner, opponents, score, rating change).
- Own profile also has a sign-out action.

**5. Chemistry**
- "Dream teams": pairs that win more than their individual ratings predict.
- "Awkward pairings": pairs that win less than predicted.
- Each row: the two players, games together, win record, a chemistry score.

**6. Matchmaker ("who's here tonight")**
- Toggle which players are present.
- Suggests 2v2 lineups that are (a) balanced and (b) mix up partnerships not played recently.
- Two modes: best single matchups, or a multi-round session plan.
- Each suggestion shows the two teams and how even/fresh it is.

**7. Seasons**
- List of seasons with top 3 of each; current season marked active.

## Cross-cutting
- Persistent bottom navigation: Ladder · Matchmaker · **Log (primary action)** · Chemistry · Me.
- Numbers (ratings, scores, deltas) are the hero content, they must be glanceable.
- Empty states for: no matches yet, not enough games for chemistry, fewer than 4 present.
- Feedback on actions: logging a match should feel responsive (loading + success states).

## Constraints
- Dark, high-contrast, readable in daylight; large tap targets; primary actions thumb-reachable.
- Installable PWA. Works on a phone held one-handed at the side of a court.
- Colours live as CSS variables in `src/app/globals.css` (`@theme`), theme there, don't hardcode in components.
