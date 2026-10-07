# Security

## Reporting a problem
Please **don't open a public issue**. Use GitHub's private reporting instead: the
**Security** tab → **Report a vulnerability**. Only the maintainer sees it.

Include what you found, how to reproduce it, and what someone could do with it. This is a
volunteer-run app for one league, so replies are best effort, but security reports come first.

Please don't test against the live app in ways that could affect the league: no brute-forcing
the sign-in code, no flooding it with games or requests, no touching other people's data. Run it
locally instead ([README](README.md#run-it-locally)); it's the same code.

## How the app is protected
Knowing the model helps you judge what counts as a vulnerability.

- **Browsing is public by design.** Anyone can see the ladder, results, players' names and who's
  said they're free in the next two weeks.
- **Signing in** takes the league's shared code (`SPIKE_PIN`) and picking a name. Anyone with the
  code can sign in as anyone; that's how the league works, not a bug. Every try at the code is
  counted before it's checked, per device and across the league (`src/lib/auth/limits.ts`), so the
  code can't be guessed quickly.
- **Admin actions** (fixing scores, deleting games, managing players) need an admin player *and* a
  second code, `SPIKE_ADMIN_CODE`, checked on every action on the server and rate-limited the same
  way.
- **Sessions** are signed cookies (HS256, `AUTH_SECRET`, 60 days). Server actions check every
  argument and the session on each call.
- **Signed-in writes** (logging games, planning a night) are capped per device, so a script can't
  flood the league.

Out of scope: the shared code being shared, the public league data above, and denial of service
by sheer volume of traffic.

## For maintainers: if something leaks
| What leaked | Do this |
|---|---|
| The shared code | Set a new `SPIKE_PIN` in Vercel and redeploy. Existing sessions stay signed in; rotate `AUTH_SECRET` too to sign everyone out. |
| `AUTH_SECRET` | Set a new one (`openssl rand -base64 32`) and redeploy. Everyone is signed out and anyone's forged cookies stop working. |
| `SPIKE_ADMIN_CODE` | Set a new one and redeploy; also rotate `AUTH_SECRET` to end any admin unlocks in progress. |
| The database URL | Reset the password in Neon, update `DATABASE_URL` in Vercel and in the `production-db` GitHub environment, and redeploy. |

If games were faked, an admin can delete them from the game's sheet; Neon can also restore the
database to a point in time.
