# Contributing

Thanks for wanting to help. This is a small app run by one league, so the bar is simple: keep it
correct, keep it fast on a phone, and keep it easy for the next person (or agent) to change.

## Before you start
- **Small fixes**: open a pull request.
- **Anything bigger** (a new screen, a change to how ratings or the matchmaker work, a new
  dependency): open an issue first and describe what you want to change and why. It saves you
  building something that can't be merged.
- **Security problems**: don't open an issue. See [SECURITY.md](SECURITY.md).

## Setting up
Follow [Run it locally](README.md#run-it-locally). Everything runs against a Postgres in Docker on
your machine with made-up data; you never need, and won't be given, access to the real league.

## Making a change
- Read [AGENTS.md](AGENTS.md). It's written for AI agents but it's the best map of the code for
  people too: where things live, why they're built the way they are, and what has been tried and
  rejected.
- **Logic goes in `src/lib/`, with tests.** There are no component tests, so anything that
  computes something belongs in the engine (`league.ts` and friends) where a test can pin it.
- **Ratings** are tuned against `scripts/rating-backtest.ts` on the real league's games, not by
  feel. If you want to change the model, open an issue with your reasoning; the maintainer runs
  the backtest.
- **Database changes**: edit `src/db/schema.ts`, then `npm run db:generate` to write a migration and
  `npm run db:migrate` to apply it locally. Commit the generated files and never edit a migration
  that has already been merged. Migrations run against the real league after merge, so they get
  the closest review.
- **UI** is phone-first: check it at 360px wide. The visual language (palette `C`, motion,
  avatars, tabs, icons) lives in `src/components/spike/ui.tsx`; use it rather than new styles, and
  match the screens around your change.
- **Dependencies**: avoid adding them. If you need one, say why in the pull request.

Before you push:

```bash
npx tsc --noEmit -p .
npm test
npm run build
```

## Pull requests
- Keep each one to one change, and explain the *why* in the description. Screenshots for anything
  visual.
- CI (typecheck, tests, build) must pass, and the maintainer reviews every change before it
  merges. Pull requests are squash-merged into `main`, and `main` deploys to the live app, so
  nothing reaches it without that review.
- If your change makes something in AGENTS.md or the README untrue, update them in the same pull
  request. That's how the next contributor finds out.

## Using AI agents
AI coding agents are welcome. Claude Code reads [CLAUDE.md](CLAUDE.md) (which points at
AGENTS.md) and picks up the project's shared settings in `.claude/settings.json`; other agents
should be pointed at AGENTS.md. A few rules hold whoever, or whatever, writes the code:

- **You own every line you submit.** Read the diff, run the checks, and be ready to explain it.
- **Never point anything at a database that isn't on your machine,** and never paste secrets or
  `.env.local` into a prompt, an issue or a commit.
- **No AI attribution lines** in commit messages or pull request descriptions (no
  `Co-Authored-By` trailers for tools, no "Generated with" footers). The project settings turn
  them off for Claude Code.

## Licence
By contributing you agree that your work is released under the project's [MIT licence](LICENSE).
