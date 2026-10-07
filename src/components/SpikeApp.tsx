"use client";

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  motion,
  AnimatePresence,
  MotionConfig,
  LayoutGroup,
} from "motion/react";
import {
  computeStandings,
  chemistryRanked,
  matchVerdict,
  isDormant,
  daysSincePlayed,
  tierOf,
  streakInfo,
  computeBadges,
  initial,
  unpackLedger,
  splitRoster,
  dayKey,
  planText as buildPlanText,
  DEFAULT_ROUNDS,
  gameMinutes,
  MAX_ROUNDS,
  PROV_N,
  PROVISIONAL_TIER,
  START,
  LEAGUE_TZ,
  type LeagueMatch,
  type PlayerStat,
  type ChemRow,
  type GridCell,
  type Tier,
  type Badge,
  type Standings,
} from "@/lib/league";
import { currentSeason, inScope, isFinal, isFresh, scopeKey, scopeMatches, seasonAt, seasonName, seasonsAt, type Scope } from "@/lib/season";
import type { LeagueData } from "@/lib/leagueData";
import {
  signIn as signInAction,
  signOut as signOutAction,
  logMatch as logMatchAction,
  toggleAvailability as toggleAvailabilityAction,
  addPlayer as addPlayerAction,
  renamePlayer as renamePlayerAction,
  editMatchScore as editMatchScoreAction,
  deleteMatch as deleteMatchAction,
  verifyGroupPin as verifyGroupPinAction,
  generateSessionPlan as generateSessionPlanAction,
  clearSessionPlan as clearSessionPlanAction,
  unlockAdmin as unlockAdminAction,
  lockAdmin as lockAdminAction,
} from "@/app/actions/league";
import { ProfileScreen } from "@/components/spike/Profile";
import { StatsScreen } from "@/components/spike/Stats";
import { HeadToHead } from "@/components/spike/HeadToHead";
import { RatingExplainer } from "@/components/spike/RatingExplainer";
import { WhyDelta } from "@/components/spike/WhyDelta";
import { ScoringGuide } from "@/components/spike/ScoringGuide";
import { SeasonPicker } from "@/components/spike/SeasonPicker";
import {
  C, press, SPRING, SOFT, BOUNCE, tap, listV, rowV, RAIL_MAX,
  AnimatedNumber, SegTabs, Avatar, medalC, TierChip, segBg, segTx,
  iconBtn, Sparkline, RankDelta, Pill, StatTile, RelCard, NavBtn, ResultRow, ordinal, rankLine,
  WinChanceBar, ScoreRail, Confetti,
  Chevron, NetIcon, EyeIcon, LockIcon, InfoIcon, EditIcon, CopyIcon, CrownIcon,
  CheckIcon, RematchIcon, LadderIcon, MmIcon, PlusIcon, UserIcon, StatsIcon,
  PlusSmall, MinusSmall, CloseIcon,
} from "@/components/spike/ui";
import { validWinBy2 } from "@/lib/validation";
import { useRouter } from "next/navigation";


// Run the scroll reset before the browser paints (so a new screen never flashes
// at the old scroll position), falling back to useEffect during SSR.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

type Screen = "login" | "ladder" | "matchmaker" | "log" | "stats" | "profile" | "me" | "history";

// What one player got out of the game just logged. Everything here is derived from two
// `computeStandings` replays — before the match and with it appended — so there's nothing
// to fetch and nothing the server has to send back.
type LogResultPlayer = {
  id: string;
  name: string;
  color: string;
  team: "A" | "B";
  won: boolean;
  delta: number;
  held: boolean; // won under par: the fit would have dropped them, the win paid the floor
  ratingBefore: number;
  ratingAfter: number;
  rankBefore?: number; // undefined while a player is still placing — no rank to move from
  rankAfter?: number; // still undefined after the game if they're short of PROV_N
  gamesAfter: number; // so the card can say how many more games until a rank appears
  tierBefore: Tier;
  tierAfter: Tier;
  provBefore: boolean;
  provAfter: boolean;
  newPeak: boolean;
  streak: { type: "W" | "L" | null; count: number };
  newBadges: Badge[];
  partnerRun: number; // consecutive wins alongside this partner, ending with this game
  tonight: { games: number; wins: number };
};

/** The reward screen's whole input, snapshotted the moment a match is submitted.
 *  Deliberately self-contained: `router.refresh()` lands while the celebration is on
 *  screen, and it must not be able to change the numbers being counted up. */
type LogResult = {
  teamA: string[];
  teamB: string[];
  scoreA: number;
  scoreB: number;
  winProbA: number; // team A's win chance from the ratings going in (0–1)
  planGameId: string | null; // set when the game came off tonight's plan
  seasonal: boolean; // counted in a season, not All time: peaks are season highs
  players: LogResultPlayer[];
};

type State = {
  screen: Screen;
  currentUser: string | null;
  guest: boolean;
  loginStage: "pin" | "pick";
  pin: string;
  pinError: string | null; // shown under the dots, and shakes them
  viewId: string | null;
  returnTo: Screen;
  ladderView: "podium" | "table" | "chemistry";
  ladderSort: { key: "rank" | "name" | "games" | "wl" | "diff" | "rating"; dir: "asc" | "desc" };
  restingOpen: boolean;
  teamA: string[];
  teamB: string[];
  scoreA: number;
  scoreB: number;
  logPlanGameId: string | null; // the plan slot this entry came from, so logging crosses it off
  logSuccess: boolean;
  lastResult: LogResult | null;
  lastLogged: LeagueMatch | null;
  present: Record<string, boolean>;
  mmRounds: number; // how many games tonight's plan should hold
  mmPlanning: boolean; // generate/re-plan in flight — disables the button
  mmGridOpen: boolean; // the "who's overdue" pair grid is expanded
  mmWhyKey: string | null; // which plan game has its reasoning open
  mmTab: "tonight" | "week";
  myAvail: Record<string, boolean>; // day -> I'm free (optimistic overlay)
  newPlayerName: string;
  savingPlayer: boolean; // admin: add/rename in flight — disables the buttons to stop double-taps
  editPlayerId: string | null; // admin: which roster row is being renamed
  editPlayerName: string;
  // The open match sheet. `clientMatchId` is carried so the sheet can follow an optimistic
  // local match onto its persisted row the moment the server copy lands.
  editMatch: { id: string; clientMatchId?: string | null; scoreA: number; scoreB: number } | null;
  editMatchSaving: boolean;
  /** Which player's rating-impact breakdown is expanded inside the open match sheet. */
  whyId: string | null;
  toast: string | null;
  /** Which view of the league the ladder, stats and profiles show. "current" follows the
   *  season in progress, so a rollover moves everyone onto the new one; a finished season is
   *  pinned by number. The matchmaker ignores this and always works from All time. */
  scope: "current" | "all" | number;
  rosterAll: boolean; // pickers show everyone, not just people who've played lately
  adminCode: string; // the admin code being typed to unlock admin
  adminBusy: boolean; // an unlock is in flight
  guideOpen: boolean; // the "how the number works" sheet, from the ⓘ on the ladder
  chemPair: ChemRow | null; // which chemistry duo's shared-games sheet is open
  heatDay: { day: string; matchIds: string[] } | null; // which heatmap day's sheet is open
  h2h: { a: string; b: string } | null; // which rivalry's sheet is open
  explainId: string | null; // whose "why is my rating this?" sheet is open
  localMatches: LeagueMatch[];
};

export default function SpikeApp({ data }: { data: LeagueData }) {
  const [s, setSAll] = useState<State>(() => ({
    screen: "ladder",
    currentUser: data.currentUserId,
    guest: !data.currentUserId,
    loginStage: "pin",
    pin: "",
    pinError: null,
    viewId: null,
    returnTo: "ladder",
    ladderView: "podium",
    ladderSort: { key: "rank", dir: "desc" },
    restingOpen: false,
    teamA: [],
    teamB: [],
    scoreA: 0,
    scoreB: 0,
    logPlanGameId: null,
    logSuccess: false,
    lastResult: null,
    lastLogged: null,
    // Tonight starts pre-filled from the saved plan if there is one, otherwise from
    // whoever said they're free today.
    present: Object.fromEntries(
      (data.sessionPlan?.roster ?? data.availabilityByDay[data.days[0]] ?? []).map((id) => [id, true]),
    ),
    mmRounds: data.sessionPlan?.roundCount ?? DEFAULT_ROUNDS,
    mmPlanning: false,
    mmGridOpen: false,
    mmWhyKey: null,
    mmTab: "tonight",
    myAvail: Object.fromEntries(
      data.days.filter((d) => data.currentUserId && data.availabilityByDay[d]?.includes(data.currentUserId)).map((d) => [d, true]),
    ),
    newPlayerName: "",
    savingPlayer: false,
    editPlayerId: null,
    editPlayerName: "",
    editMatch: null,
    whyId: null,
    heatDay: null,
    h2h: null,
    explainId: null,
    editMatchSaving: false,
    toast: null,
    scope: "current",
    rosterAll: false,
    adminCode: "",
    adminBusy: false,
    guideOpen: false,
    chemPair: null,
    localMatches: [],
  }));
  const setS = (patch: Partial<State>) => setSAll((prev) => ({ ...prev, ...patch }));
  const router = useRouter();

  // ---------- pull-to-refresh (standalone PWAs lose the native one) ----------
  const [pull, setPull] = useState(0);
  const [refreshing, startRefresh] = useTransition();
  const ptr = useRef({ startY: 0, active: false, dist: 0 });
  const uiRef = useRef({ sheetOpen: false, screen: "ladder" as Screen, busy: false });
  const inFlight = useRef(false); // guards against a double-tap logging the same match twice
  const playerInFlight = useRef(false); // synchronous guard: a double-tap on Add/Save can't fire the action twice
  const availInFlight = useRef<Set<string>>(new Set()); // days with a toggle in flight (per-day double-tap guard)
  const planInFlight = useRef(false); // synchronous guard: a double-tap can't generate twice
  const adminInFlight = useRef(false); // synchronous guard: one unlock attempt at a time
  useEffect(() => {
    const THRESH = 64, MAX = 90;
    const canPull = () => !uiRef.current.sheetOpen && uiRef.current.screen !== "login" && !uiRef.current.busy && window.scrollY <= 0;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || !canPull()) { ptr.current.active = false; return; }
      // A gesture that starts on a horizontal scroller belongs to it. Otherwise a thumb flick
      // along the score rail that drifts a few pixels down gets preventDefault'd into a
      // pull-to-refresh, freezing the rail mid-slide.
      const t = e.target;
      if (t instanceof Element && t.closest(".spk-rail")) { ptr.current.active = false; return; }
      ptr.current = { startY: e.touches[0].clientY, active: true, dist: 0 };
    };
    const onMove = (e: TouchEvent) => {
      if (!ptr.current.active) return;
      const dy = e.touches[0].clientY - ptr.current.startY;
      if (dy > 0 && window.scrollY <= 0) {
        const p = Math.min(MAX, dy * 0.5);
        ptr.current.dist = p;
        setPull(p);
        if (p > 4 && e.cancelable) e.preventDefault();
      } else {
        ptr.current.dist = 0;
        setPull(0);
      }
    };
    const onEnd = () => {
      if (!ptr.current.active) return;
      const fire = ptr.current.dist >= THRESH;
      ptr.current.active = false;
      ptr.current.dist = 0;
      setPull(0);
      if (fire) startRefresh(() => router.refresh());
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A phone left open overnight holds yesterday's page: its "Today", its matchmaker day, and
  // which season is in progress. Coming back to it on a new day fetches a fresh one.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && dayKey(Date.now()) !== dayKey(data.now)) startRefresh(() => router.refresh());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [data.now, router]);

  // Merge server matches with optimistic local ones, dropping any local copy that
  // the server has already persisted. `logMatch` calls revalidatePath("/"), so after a
  // refresh `data.matches` includes the just-logged match (carrying its clientMatchId);
  // without this dedupe the optimistic copy would double-count until a hard reload.
  const allMatches = useMemo(() => {
    const serverCids = new Set(
      data.matches.map((m) => m.clientMatchId).filter((c): c is string => !!c)
    );
    const pendingLocal = s.localMatches.filter(
      (m) => !m.clientMatchId || !serverCids.has(m.clientMatchId)
    );
    return [...data.matches, ...pendingLocal];
  }, [data.matches, s.localMatches]);

  // Once a revalidation lands the optimistic match in server data, drop the local copy
  // so localMatches doesn't grow unbounded across many logs in one session.
  useEffect(() => {
    const serverCids = new Set(
      data.matches.map((m) => m.clientMatchId).filter((c): c is string => !!c)
    );
    setSAll((prev) => {
      const kept = prev.localMatches.filter(
        (m) => !m.clientMatchId || !serverCids.has(m.clientMatchId)
      );
      return kept.length === prev.localMatches.length ? prev : { ...prev, localMatches: kept };
    });
  }, [data.matches]);
  // ---------- seasons ----------
  // Every screen but the matchmaker shows one view of the league: a season, or All time.
  const seasons = data.seasons;
  const current = currentSeason(seasons);
  const multiSeason = seasons.length > 1;
  // With a single season there's nothing to tell apart: it *is* All time, and the app reads
  // exactly as it did before seasons existed.
  const scope: Scope =
    !multiSeason || s.scope === "all" ? "all" : s.scope !== "current" && seasons.some((x) => x.n === s.scope) ? s.scope : current.n;
  const pastSeason = isFinal(scope, seasons); // a finished season: its table is final
  // What a game logged now is played to: the season in progress's rule (21, then 17 from Season 2).
  const pointsTo = current.to;
  // …and what a game in the view on screen is played to, for the what-if (All time: a game now).
  const viewTo = scope === "all" ? current.to : seasons.find((x) => x.n === scope)?.to ?? current.to;
  // A season shows its own ratings and tiers (everyone started it on START) and nothing from All
  // time: the all-time numbers appear only when All time is on screen.
  const seasonView = scope !== "all";
  const setScope = (sc: Scope) => setS({ scope: sc === current.n ? "current" : sc });

  // The server's ledgers and rank ranges ride along on every call: with them a standings pass
  // is a couple of ms; without them the client would refit every game on each render. A view
  // is computed only when something asks for it, and then once per change to the data.
  const allLedger = useMemo(() => {
    const l = data.ratings.all?.ledger;
    return l ? unpackLedger(l) : undefined;
  }, [data.ratings]);
  const standingsFor = useMemo(() => {
    const made = new Map<string, Standings>();
    return (sc: Scope): Standings => {
      const key = scopeKey(sc);
      let out = made.get(key);
      if (!out) {
        const r = data.ratings[key];
        // A null ledger means this view's games are a prefix of All time's, so that one serves it.
        // (A later season never borrows; computeStandings refuses a ledger built on other priors.)
        const ledger = r?.ledger ? unpackLedger(r.ledger) : allLedger;
        out = computeStandings(data.players, scopeMatches(allMatches, sc, seasons), { ledger, rankRanges: r?.rankRanges, final: isFinal(sc, seasons), fresh: isFresh(sc, seasons) });
        made.set(key, out);
      }
      return out;
    };
  }, [data.players, data.ratings, seasons, allMatches, allLedger]);
  const cs = standingsFor(scope);
  const scopedMatches = useMemo(() => scopeMatches(allMatches, scope, seasons), [allMatches, scope, seasons]);
  // Ladder positions as they stood *before the latest session*, so we can show who
  // climbed or slipped tonight. Anything within 10h of the most recent game counts
  // as "this session"; we replay the rest. Null until there's enough prior history.
  const prevRanks = useMemo<Record<string, number> | null>(() => {
    if (scopedMatches.length < 6) return null;
    const sorted = [...scopedMatches].sort((a, b) => a.order - b.order);
    const tMax = sorted[sorted.length - 1].order;
    const SESSION_MS = 10 * 60 * 60 * 1000;
    const prev = sorted.filter((m) => m.order < tMax - SESSION_MS);
    if (prev.length < 4) return null;
    const pcs = computeStandings(data.players, prev, { ledger: cs.ledger, final: cs.final, fresh: cs.fresh });
    const r: Record<string, number> = {};
    pcs.ranked.forEach((p) => { if (p.rank) r[p.id] = p.rank; });
    return r;
  }, [scopedMatches, data.players, cs]);
  const A = (id: string): PlayerStat => cs.st[id];
  const me = s.currentUser;
  const guest = s.guest && !me;
  const roster = data.players.filter((p) => p.active); // active players for pickers
  const amAdmin = !!(me && data.adminIds.includes(me));
  // Being an admin player isn't enough: anyone can sign in as one with the shared code. Admin
  // controls show only once this session has been unlocked with the admin code, and the server
  // checks again on every admin action.
  const adminOn = amAdmin && data.adminUntil !== null;

  // Whoever's tapped in at the court — the draft roster the chips edit, which becomes the
  // plan's roster next time it's generated.
  const presentIds = useMemo(
    () => data.players.filter((p) => p.active && s.present[p.id]).map((p) => p.id),
    [data.players, s.present],
  );

  // Tonight's plan comes off the server, not from a local re-derivation, so it stays put
  // as scores land instead of reshuffling underneath whoever's reading it. Games are
  // grouped into rounds; a round's sitters are the roster minus whoever's on a court.
  const plan = useMemo(() => {
    const sp = data.sessionPlan;
    if (!sp) return null;
    const byRound = new Map<number, typeof sp.games>();
    for (const g of sp.games) {
      const list = byRound.get(g.roundNo) ?? [];
      list.push(g);
      byRound.set(g.roundNo, list);
    }
    const rounds = [...byRound.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([roundNo, games]) => {
        const playing = new Set(games.flatMap((g) => [...g.teamA, ...g.teamB]));
        return {
          roundNo,
          games: [...games].sort((a, b) => a.courtNo - b.courtNo),
          out: sp.roster.filter((id) => !playing.has(id)),
        };
      });
    const perPlayer: Record<string, { games: number; sits: number }> = {};
    sp.roster.forEach((id) => (perPlayer[id] = { games: 0, sits: 0 }));
    for (const rd of rounds) {
      for (const g of rd.games) for (const id of [...g.teamA, ...g.teamB]) if (perPlayer[id]) perPlayer[id].games++;
      for (const id of rd.out) if (perPlayer[id]) perPlayer[id].sits++;
    }
    return { ...sp, rounds, perPlayer, played: sp.games.filter((g) => g.matchId).length };
  }, [data.sessionPlan]);

  // Has the roster or game count been changed since the plan was generated?
  const planStale = useMemo(() => {
    if (!plan) return false;
    const a = [...plan.roster].sort().join(","), b = [...presentIds].sort().join(",");
    return a !== b || plan.roundCount !== s.mmRounds;
  }, [plan, presentIds, s.mmRounds]);

  // Adopt the saved plan whenever the server's copy changes — someone else re-planned, or our
  // own round count got clamped up to cover rounds already played. Without this the controls
  // keep showing our stale draft and "Line-up changed" never clears.
  const seenPlan = useRef<string | null>(null);
  useEffect(() => {
    const sig = plan ? plan.roundCount + ":" + [...plan.roster].sort().join(",") : null;
    if (sig === seenPlan.current) return;
    seenPlan.current = sig;
    if (!plan) return;
    setSAll((prev) => ({
      ...prev,
      mmRounds: plan.roundCount,
      present: Object.fromEntries(plan.roster.map((id) => [id, true])),
    }));
  }, [plan]);

  // Keep the pull-to-refresh gate current (read inside listeners via ref, no re-subscribe).
  // An open bottom sheet blocks the gesture, so a pull can't fire behind it.
  uiRef.current = { sheetOpen: s.guideOpen || !!s.chemPair, screen: s.screen, busy: refreshing };

  // Always land at the top when the screen (or viewed profile) changes. A layout
  // effect resets scroll synchronously before paint, so the new screen never
  // briefly appears scrolled down.
  useIsoLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [s.screen, s.viewId]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (m: string) => {
    setS({ toast: m });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setS({ toast: null }), 1900);
  };

  // Press-and-hold to repeat (+/- steppers). One press at a time, so one shared timer.
  // Callers pair this with `.spk-noselect` and an SVG glyph: preventDefault on pointerdown
  // can't stop a long press from selecting text or raising iOS's callout, because Safari
  // decides that gesture off the touch stream. onContextMenu covers Android's equivalent.
  const holdRef = useRef<{ to?: ReturnType<typeof setTimeout>; iv?: ReturnType<typeof setInterval> }>({});
  const clearHold = () => { clearTimeout(holdRef.current.to); clearInterval(holdRef.current.iv); holdRef.current = {}; };
  useEffect(() => clearHold, []);
  const holdBind = (fn: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      clearHold();
      fn();
      holdRef.current.to = setTimeout(() => { holdRef.current.iv = setInterval(fn, 75); }, 300);
    },
    onPointerUp: clearHold,
    onPointerLeave: clearHold,
    onPointerCancel: clearHold,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  // ---------- navigation ----------
  // Leaving the Log screen dismisses a celebration still on it — coming back should offer a
  // fresh form, not last game's confetti with no way past it but the X.
  const nav = (screen: Screen) =>
    setSAll((p) => ({ ...p, ...(p.screen === "log" && p.logSuccess ? clearLog : null), screen, guideOpen: false }));
  const openProfile = (id: string) =>
    setSAll((p) => ({ ...p, screen: "profile", viewId: id, returnTo: p.screen === "profile" ? p.returnTo : p.screen }));
  const goBack = () => setS({ screen: s.returnTo || "ladder" });

  // ---------- auth ----------
  // Flow: enter the shared group code -> pick which player you are -> signed in.
  // A refusal says why under the dots: "too many tries" must not read as "wrong code",
  // or someone who has the right code keeps retyping it into a lockout.
  const codeError = (e: string) => (e === "Wrong code." ? "Wrong code, try again" : e);
  const pinPress = async (d: string) => {
    if (d === "back") { setS({ pin: s.pin.slice(0, -1), pinError: null }); return; }
    if (s.pin.length >= data.pinLength) return;
    const pin = s.pin + d;
    setS({ pin });
    if (pin.length === data.pinLength) {
      const res = await verifyGroupPinAction(pin);
      if (res.ok) setS({ loginStage: "pick", pinError: null }); // keep pin for the final signIn
      else setS({ pin: "", pinError: codeError(res.error) });
    }
  };
  const pickName = async (id: string) => {
    const res = await signInAction(id, s.pin);
    if (res.ok) setS({ currentUser: id, guest: false, screen: "ladder", loginStage: "pin", pin: "" });
    else setS({ loginStage: "pin", pin: "", pinError: codeError(res.error) });
  };
  const pinBack = () => setS({ loginStage: "pin", pin: "", pinError: null });
  const enterGuest = () => setS({ screen: "ladder", guest: true, currentUser: null, ladderView: "podium" });
  const startSignIn = () => setS({ screen: "login", loginStage: "pin", guest: false, pin: "", pinError: null });
  const doSignOut = async () => {
    await signOutAction();
    setS({ currentUser: null, guest: true, screen: "ladder", loginStage: "pin", pin: "" });
  };

  // ---------- matchmaker / present ----------
  const togglePresent = (id: string) => setS({ present: { ...s.present, [id]: !s.present[id] } });

  // ---------- log ----------
  // Editing the line-up by hand detaches it from whatever plan slot it was prefilled
  // from, so a hand-picked foursome can never claim someone else's game.
  const assign = (id: string) => {
    let { teamA, teamB } = s;
    teamA = [...teamA]; teamB = [...teamB];
    if (teamA.includes(id)) { teamA = teamA.filter((x) => x !== id); if (teamB.length < 2) teamB.push(id); }
    else if (teamB.includes(id)) { teamB = teamB.filter((x) => x !== id); }
    else { if (teamA.length < 2) teamA.push(id); else if (teamB.length < 2) teamB.push(id); }
    setS({ teamA, teamB, logPlanGameId: null });
  };
  // Tap a team to declare them the winner: 21–0 to start, then slide the loser's score.
  const declareWinner = (team: "A" | "B") =>
    setSAll((prev) => (team === "A" ? { ...prev, scoreA: pointsTo, scoreB: 0 } : { ...prev, scoreB: pointsTo, scoreA: 0 }));
  // Set the losing team's score; the winner auto-tracks max(21, loser + 2), which is what
  // keeps win-by-2 structural — the rail can't put the form into an invalid state.
  const setLoser = (loserTeam: "A" | "B", value: number) =>
    setSAll((prev) => {
      const lo = Math.max(0, Math.min(RAIL_MAX, value));
      const win = Math.max(pointsTo, lo + 2);
      return loserTeam === "A" ? { ...prev, scoreA: lo, scoreB: win } : { ...prev, scoreB: lo, scoreA: win };
    });
  const rematch = () => {
    const m = s.lastLogged;
    if (!m) return;
    setS({ logSuccess: false, lastResult: null, teamA: [...m.teamA], teamB: [...m.teamB], scoreA: 0, scoreB: 0, logPlanGameId: null });
  };
  // Fill the log form from a plan slot and go there. This is the only way a plan game gets
  // logged now — the matchmaker no longer has its own score entry.
  const logPlanGame = (g: { id: string; teamA: string[]; teamB: string[] }) =>
    setS({ screen: "log", logSuccess: false, lastResult: null, teamA: [...g.teamA], teamB: [...g.teamB], scoreA: 0, scoreB: 0, logPlanGameId: g.id });

  /**
   * Everything the reward screen shows, from the two standings replays we already have.
   * `before` is the view the game counts in (the season in progress, or All time if that's
   * what's on screen); `after` is the same thing with the optimistic match appended.
   * Ranks are read straight off `PlayerStat.rank` — the same field the ladder renders — so the
   * "#4" here can't drift from the "#4" they'll see when they tap through. It's undefined for a
   * player with no games, which is exactly what we want for a first-ever match.
   */
  const buildLogResult = (m: LeagueMatch, before: Standings, after: Standings, planGameId: string | null, seasonal: boolean): LogResult => {
    const allTime = standingsFor("all"); // before this game: the optimistic copy isn't in allMatches yet
    const view = seasonal ? { period: "this season", final: false } : null;
    const players = ([...m.teamA.map((id) => [id, "A"] as const), ...m.teamB.map((id) => [id, "B"] as const)]).map(
      ([id, team]): LogResultPlayer => {
        const pa = after.st[id], pb = before.st[id];
        const last = pa.matches[pa.matches.length - 1];
        // Diff on the badge `id`, not the label: ids are stable identities, whereas a desc
        // like "3-game win streak" moves with the count.
        const had = new Set(computeBadges(pb, view).map((b) => b.id));
        // How long this partnership has been winning, this game included.
        let partnerRun = 0;
        for (let i = pa.matches.length - 1; i >= 0; i--) {
          const e = pa.matches[i];
          if (e.partner !== last.partner || !e.won) break;
          partnerRun++;
        }
        const today = pa.matches.filter((e) => e.date === "Today");
        return {
          id, name: pa.name, color: pa.color, team, won: last.won,
          // The engine now records what each game moved a player from and to, so take the
          // pair straight off the entry rather than inferring it from two standings.
          delta: last.delta, held: last.won && last.delta - last.held < 0, ratingBefore: last.ratingBefore, ratingAfter: last.ratingAfter,
          rankBefore: pb.rank, rankAfter: pa.rank, gamesAfter: pa.games,
          tierBefore: tierOf(pb.rating, pb.provisional), tierAfter: tierOf(pa.rating, pa.provisional),
          provBefore: pb.provisional, provAfter: pa.provisional,
          // A season high only counts once you're placed — otherwise every winner on a season's
          // first night would be "at their peak" off a single game.
          newPeak: pa.rating === pa.peak && pa.rating > pb.peak && (!seasonal || !pa.provisional),
          streak: pa.streak,
          // "Placing" isn't news to a veteran starting a new season: only to someone new to the league.
          newBadges: computeBadges(pa, view).filter((b) => !had.has(b.id) && (b.id !== "rookie" || !allTime.st[id]?.games)),
          partnerRun,
          tonight: { games: today.length, wins: today.filter((e) => e.won).length },
        };
      },
    );
    const first = after.st[m.teamA[0]];
    return {
      teamA: [...m.teamA], teamB: [...m.teamB], scoreA: m.scoreA, scoreB: m.scoreB,
      winProbA: first.matches[first.matches.length - 1].winProb,
      planGameId, seasonal, players,
    };
  };

  // The rating maths is entirely local, so there's nothing to wait for: celebrate straight
  // away and let the write settle behind it. If the server rejects it we come back to the
  // form with the teams and score still filled in, so nothing typed is ever lost.
  const submitMatch = async () => {
    const { teamA, teamB, scoreA, scoreB, logPlanGameId } = s;
    if (teamA.length < 2 || teamB.length < 2 || !validWinBy2(scoreA, scoreB, pointsTo)) return;
    if (inFlight.current) return; // double-tap guard
    inFlight.current = true;
    const clientMatchId = crypto.randomUUID();
    // The reward shows the season in progress — the view the game counts in, whatever was on
    // screen — and logging puts the app back on it, so the rank shown is the rank they'll see.
    // Read the seasons off this phone's clock: a page loaded before a season began still holds
    // the old ones, and the server will date this game by the time it arrives.
    const loggedAt = Date.now();
    const nowSeasons = seasonsAt(loggedAt);
    const newMatch: LeagueMatch = {
      id: "local-" + clientMatchId, date: "Today", order: loggedAt,
      teamA: [...teamA], teamB: [...teamB], scoreA, scoreB, clientMatchId,
      to: currentSeason(nowSeasons).to,
    };
    const live: Scope = nowSeasons.length > 1 ? currentSeason(nowSeasons).n : "all";
    const liveMatches = scopeMatches(allMatches, live, nowSeasons);
    const fresh = isFresh(live, nowSeasons);
    const before = nowSeasons.length === seasons.length
      ? standingsFor(live)
      : computeStandings(data.players, liveMatches, { ledger: fresh ? undefined : allLedger, fresh });
    const csNew = computeStandings(data.players, [...liveMatches, newMatch], { ledger: before.ledger, fresh });
    const prevLogged = s.lastLogged; // so a rejected write doesn't cost us the Rematch shortcut
    setS({
      localMatches: [...s.localMatches, newMatch],
      logSuccess: true, lastLogged: newMatch, scope: "current",
      lastResult: buildLogResult(newMatch, before, csNew, logPlanGameId, live !== "all"),
    });
    // Put the form back exactly as it was, still filled in, so a bad night on the court WiFi
    // never costs someone a result they've already typed.
    const revert = (msg: string) => {
      setSAll((prev) => ({
        ...prev, logSuccess: false, lastResult: null, lastLogged: prevLogged,
        localMatches: prev.localMatches.filter((x) => x.clientMatchId !== clientMatchId),
      }));
      showToast(msg);
    };
    try {
      const res = await logMatchAction({
        team1: teamA, team2: teamB, score1: scoreA, score2: scoreB, clientMatchId,
        planGameId: logPlanGameId ?? undefined,
      });
      if (!res.ok) { revert(res.error); return; }
      router.refresh(); // lands the plan cross-off; the localMatches dedupe covers the overlap
    } catch {
      // A throw (offline, 500, dropped request) is the case the optimistic screen exists for —
      // without this it would sit there showing real-looking ratings for a match never saved.
      revert("Couldn't reach the server. Try again.");
    } finally {
      inFlight.current = false;
    }
  };
  const clearLog: Partial<State> = { logSuccess: false, teamA: [], teamB: [], scoreA: 0, scoreB: 0, lastResult: null, logPlanGameId: null };
  // One way out of the reward screen, and it goes wherever the next game is: back to the plan
  // if this one came off it, otherwise a fresh form. The ladder is one tap away in the nav and
  // every player's new rank is already on the screen, so there's nothing to send them there for.
  const dismissLogResult = () =>
    setS({ ...clearLog, screen: s.lastResult?.planGameId ? "matchmaker" : "log" });

  // ---------- rules ----------
  // availability (optimistic overlay for me; others come from server data)
  const toggleAvail = async (day: string) => {
    if (!me) { showToast("Sign in to set availability"); return; }
    if (availInFlight.current.has(day)) return; // ignore rapid re-taps: the server toggle would race
    availInFlight.current.add(day);
    setSAll((prev) => ({ ...prev, myAvail: { ...prev.myAvail, [day]: !prev.myAvail[day] } }));
    try {
      const res = await toggleAvailabilityAction(day);
      if (!res.ok) showToast(res.error);
    } finally {
      availInFlight.current.delete(day);
    }
  };

  // admin: add / remove players (refresh server data after)
  const doAddPlayer = async () => {
    const name = s.newPlayerName.trim();
    // Ref guard runs synchronously so a rapid second tap bails before the state update
    // (which drives the disabled button) has a chance to commit. Without it a duplicate
    // add is silent — you end up with two players sharing a display name.
    if (!name || playerInFlight.current) return;
    playerInFlight.current = true;
    setS({ savingPlayer: true });
    try {
      const res = await addPlayerAction(name);
      if (res.ok) { setS({ newPlayerName: "" }); router.refresh(); showToast(`Added ${name}`); }
      else adminRefused(res.error);
    } finally {
      playerInFlight.current = false;
      setS({ savingPlayer: false });
    }
  };
  const startRename = (id: string, name: string) => setS({ editPlayerId: id, editPlayerName: name });
  const cancelRename = () => setS({ editPlayerId: null, editPlayerName: "" });
  const doRenamePlayer = async () => {
    const id = s.editPlayerId;
    const name = s.editPlayerName.trim();
    if (!id || !name || playerInFlight.current) return;
    playerInFlight.current = true;
    setS({ savingPlayer: true });
    try {
      const res = await renamePlayerAction(id, name);
      if (res.ok) { setS({ editPlayerId: null, editPlayerName: "" }); router.refresh(); showToast(`Renamed to ${name}`); }
      else adminRefused(res.error);
    } finally {
      playerInFlight.current = false;
      setS({ savingPlayer: false });
    }
  };

  // Tapping any result opens its sheet — everyone sees the rating impact; admins also
  // get score edit / delete controls in there. After an edit we reload from the DB and
  // drop the local optimistic matches so the server stays the single source of truth.
  const openMatchSheet = (m: LeagueMatch) =>
    setS({ editMatch: { id: m.id, clientMatchId: m.clientMatchId ?? null, scoreA: m.scoreA, scoreB: m.scoreB }, whyId: null });
  /** For callers holding only an id (profile history, heatmap day) rather than the match. */
  const openMatchById = (id: string) => {
    const m = allMatches.find((x) => x.id === id);
    if (m) openMatchSheet(m);
  };
  const closeMatchSheet = () => setS({ editMatch: null, whyId: null });
  // Each side moves independently so an admin can push either team ahead and flip
  // the winner; win-by-2 is enforced on save, not by coupling the steppers.
  const setEditScore = (which: "A" | "B", d: number) =>
    setSAll((prev) => {
      if (!prev.editMatch) return prev;
      const em = prev.editMatch;
      const scoreA = which === "A" ? Math.max(0, Math.min(40, em.scoreA + d)) : em.scoreA;
      const scoreB = which === "B" ? Math.max(0, Math.min(40, em.scoreB + d)) : em.scoreB;
      return { ...prev, editMatch: { ...em, scoreA, scoreB } };
    });
  const saveEditMatch = async () => {
    const em = s.editMatch;
    if (!em || !validWinBy2(em.scoreA, em.scoreB, allMatches.find((x) => x.id === em.id)?.to)) return;
    setS({ editMatchSaving: true });
    const res = await editMatchScoreAction(em.id, em.scoreA, em.scoreB);
    setS({ editMatchSaving: false });
    if (res.ok) { setS({ editMatch: null, localMatches: [] }); router.refresh(); showToast("Score updated"); }
    else adminRefused(res.error);
  };
  const doDeleteMatch = async () => {
    const em = s.editMatch;
    if (!em) return;
    setS({ editMatchSaving: true });
    const res = await deleteMatchAction(em.id);
    setS({ editMatchSaving: false });
    if (res.ok) { setS({ editMatch: null, localMatches: [] }); router.refresh(); showToast("Match deleted"); }
    else adminRefused(res.error);
  };

  // ---------- admin unlock ----------
  // An unlock that ran out (or was locked on another tab) only shows up when the server refuses
  // an admin action, so a refusal also refreshes: the controls then lock to match.
  const adminRefused = (error: string) => { showToast(error); router.refresh(); };
  const doUnlockAdmin = async () => {
    if (adminInFlight.current || !s.adminCode) return;
    adminInFlight.current = true;
    setS({ adminBusy: true });
    try {
      const res = await unlockAdminAction(s.adminCode);
      if (!res.ok) { showToast(res.error); return; }
      setS({ adminCode: "" });
      router.refresh();
      showToast("Admin unlocked");
    } catch {
      showToast("Couldn't reach the server.");
    } finally {
      adminInFlight.current = false;
      setS({ adminBusy: false });
    }
  };
  const doLockAdmin = async () => {
    await lockAdminAction();
    router.refresh();
    showToast("Admin locked");
  };

  // ---------- session plan ----------
  const makePlan = async () => {
    if (planInFlight.current) return;
    planInFlight.current = true;
    setS({ mmPlanning: true });
    try {
      const res = await generateSessionPlanAction(presentIds, s.mmRounds);
      if (!res.ok) { showToast(res.error); return; }
      router.refresh();
      showToast(plan ? "Plan updated" : "Plan ready");
    } catch {
      showToast("Couldn't reach the server.");
    } finally {
      planInFlight.current = false;
      setS({ mmPlanning: false });
    }
  };

  const dropPlan = async () => {
    if (planInFlight.current) return;
    planInFlight.current = true;
    setS({ mmPlanning: true });
    try {
      const res = await clearSessionPlanAction();
      if (!res.ok) { showToast(res.error); return; }
      router.refresh();
      showToast("Plan cleared");
    } catch {
      showToast("Couldn't reach the server.");
    } finally {
      planInFlight.current = false;
      setS({ mmPlanning: false });
    }
  };

  // ===================================================================
  // RENDER
  // ===================================================================

  if (s.screen === "login") return renderLogin();

  const titles: Record<string, string> = { ladder: "The Ladder", matchmaker: "Matchmaker", log: "Log a Match", stats: "League Stats", me: "Me", history: "All games" };
  let title = titles[s.screen] || "";
  if (s.screen === "profile") { const p = A(s.viewId!); title = s.viewId === me ? "Profile" : p?.name ?? ""; }
  // How the current view reads in a sentence: "this season", "in Season 1", "all-time".
  const period = scope === "all" ? "all-time" : pastSeason ? `in ${seasonName(scope)}` : "this season";
  const showBack = s.screen === "profile" || s.screen === "history";
  // View-only (no sign-in): just the ladder, player profiles and the games history.
  const guestAllowed = s.screen === "ladder" || s.screen === "profile" || s.screen === "history" || s.screen === "stats";
  const showGate = guest && !guestAllowed;
  // The season switch sits wherever the numbers depend on it. Not on the matchmaker (always All
  // time) or the Log screen (a new game always lands in the season in progress).
  const showPicker = multiSeason && !showGate && ["ladder", "stats", "profile", "history", "me"].includes(s.screen);
  // On the league's own screens the switch IS the title — the bottom nav already says which
  // screen you're on, and it keeps the header to one uncluttered line. Elsewhere it's a pill.
  const pickerIsTitle = showPicker && ["ladder", "stats", "history"].includes(s.screen);
  const gamesPerView: Record<string, number> = {};
  if (showPicker) for (const sc of ["all", ...seasons.map((x) => x.n)] as Scope[]) gamesPerView[scopeKey(sc)] = scopeMatches(allMatches, sc, seasons).length;
  const firstGame = allMatches.reduce((t, m) => (t === 0 || m.order < t ? m.order : t), 0) || undefined;

  return (
   <MotionConfig reducedMotion="user">
    <div style={{ minHeight: "100dvh", background: C.bg, color: C.fg, maxWidth: 480, margin: "0 auto", position: "relative", fontFeatureSettings: "'cv11','ss01'" }}>
      {/* TOAST */}
      <AnimatePresence>
        {s.toast && (
          <motion.div
            key={s.toast}
            initial={{ opacity: 0, y: -16, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={BOUNCE}
            style={{ position: "fixed", top: "calc(14px + env(safe-area-inset-top))", left: "50%", x: "-50%", zIndex: 200, background: C.raised, border: "1px solid rgba(255,255,255,.1)", color: C.fg, fontSize: 13, fontWeight: 600, padding: "10px 16px", borderRadius: 999, boxShadow: "0 12px 30px rgba(0,0,0,.5)", whiteSpace: "nowrap" }}
          >{s.toast}</motion.div>
        )}
      </AnimatePresence>

      {/* PULL TO REFRESH */}
      {(pull > 0 || refreshing) && (
        <div style={{ position: "fixed", top: "calc(env(safe-area-inset-top) - 4px)", left: "50%", zIndex: 120, transform: `translateX(-50%) translateY(${refreshing ? 16 : Math.min(pull, 90)}px)`, transition: pull > 0 && !refreshing ? "none" : "transform .25s cubic-bezier(.22,1,.36,1)", pointerEvents: "none" }}>
          <div style={{ width: 34, height: 34, borderRadius: 999, background: C.raised, border: "1px solid rgba(255,255,255,.1)", boxShadow: "0 8px 24px rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", opacity: refreshing ? 1 : Math.min(1, pull / 64) }}>
            <div style={{ width: 16, height: 16, borderRadius: 999, border: `2px solid ${C.accent}`, borderTopColor: "transparent", animation: refreshing ? "spkSpin .7s linear infinite" : "none", transform: refreshing ? undefined : `rotate(${pull * 3}deg)`, opacity: refreshing ? 1 : 0.5 + Math.min(0.5, pull / 128) }} />
          </div>
        </div>
      )}

      {/* HEADER */}
      <div style={{ position: "sticky", top: 0, zIndex: 30, padding: "calc(14px + env(safe-area-inset-top)) 18px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid rgba(255,255,255,.05)", background: C.bg }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          {showBack && (
            <button onClick={goBack} className={press} style={iconBtn}>
              <Chevron dir="left" />
            </button>
          )}
          {/* Keyed on the screen so moving screen closes an open menu. */}
          {pickerIsTitle ? (
            <SeasonPicker key={s.screen} variant="title" seasons={seasons} value={scope} games={gamesPerView} firstGame={firstGame} onChange={setScope} />
          ) : (
            <div style={{ minWidth: 0, fontSize: 20, fontWeight: 800, letterSpacing: "-.02em", lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {/* "How does the number work?" — one tap, guests included. */}
          {s.screen === "ladder" && (
            <button onClick={() => setS({ guideOpen: true })} className={press} aria-label="How the rating works" style={{ ...iconBtn, color: C.accent }}>
              <InfoIcon size={17} />
            </button>
          )}
          {guest && <button onClick={startSignIn} className={press} style={{ background: C.accent, border: "none", borderRadius: 10, height: 34, padding: "0 14px", color: C.ink, fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>Sign in</button>}
          {showPicker && !pickerIsTitle && <SeasonPicker key={s.screen} seasons={seasons} value={scope} games={gamesPerView} firstGame={firstGame} onChange={setScope} />}
        </div>
      </div>

      {/* CONTENT */}
      <div style={{ padding: "0 0 calc(108px + env(safe-area-inset-bottom))" }}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={showGate ? `gate-${s.screen}` : s.screen === "profile" ? `profile-${s.viewId}` : s.screen}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { ...SOFT, when: "beforeChildren" } }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
          >
            {showGate && renderGate()}
            {s.screen === "ladder" && renderLadder()}
            {s.screen === "matchmaker" && !showGate && renderMatchmaker()}
            {s.screen === "log" && !showGate && renderLog()}
            {s.screen === "stats" && (
              <StatsScreen cs={cs} players={data.players} matches={scopedMatches} me={me} final={pastSeason} to={viewTo} onOpenPlayer={openProfile} onOpenMatch={openMatchById} />
            )}
            {s.screen === "profile" && renderProfile()}
            {s.screen === "me" && !showGate && renderMe()}
            {s.screen === "history" && renderHistory()}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* SCORING GUIDE SHEET — how the number works, in plain English */}
      <AnimatePresence>
        {s.guideOpen && (
          <motion.div
            onClick={() => setS({ guideOpen: false })}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
            style={{ position: "fixed", inset: 0, zIndex: 150, background: "rgba(0,0,0,.55)", backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
          >
            <motion.div
              onClick={(e) => e.stopPropagation()}
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={SOFT}
              style={{ width: "100%", maxWidth: 480, background: "#16191C", borderTop: "1px solid rgba(255,255,255,.1)", borderRadius: "22px 22px 0 0", padding: "18px 18px calc(24px + env(safe-area-inset-bottom))", maxHeight: "86vh", display: "flex", flexDirection: "column" }}
            >
              <div style={{ width: 38, height: 4, borderRadius: 99, background: "rgba(255,255,255,.15)", margin: "0 auto 16px", flexShrink: 0 }} />
              <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 14, flexShrink: 0 }}>How the rating works</div>
              <div style={{ overflowY: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 4 }}>
                <ScoringGuide cs={cs} meId={me} season={multiSeason ? current.n : null} />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* HEATMAP DAY SHEET — every game played on one day of the activity grid */}
      <AnimatePresence>
        {s.heatDay && (() => {
          const hd = s.heatDay;
          const dayGames = allMatches
            .filter((m) => hd.matchIds.includes(m.id))
            .sort((x, y) => y.order - x.order);
          const nice = new Date(`${hd.day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
          return (
            <motion.div
              onClick={() => setS({ heatDay: null })}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
              style={{ position: "fixed", inset: 0, zIndex: 150, background: "rgba(0,0,0,.55)", backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
            >
              <motion.div
                onClick={(e) => e.stopPropagation()}
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={SOFT}
                style={{ width: "100%", maxWidth: 480, background: "#16191C", borderTop: "1px solid rgba(255,255,255,.1)", borderRadius: "22px 22px 0 0", padding: "18px 18px calc(24px + env(safe-area-inset-bottom))", maxHeight: "82vh", display: "flex", flexDirection: "column" }}
              >
                <div style={{ width: 38, height: 4, borderRadius: 99, background: "rgba(255,255,255,.15)", margin: "0 auto 16px", flexShrink: 0 }} />
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 14, flexShrink: 0 }}>
                  <span style={{ fontSize: 17, fontWeight: 800 }}>{nice}</span>
                  <span style={{ fontSize: 12, color: C.dim, fontWeight: 600 }}>{dayGames.length} game{dayGames.length === 1 ? "" : "s"}</span>
                </div>
                <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, WebkitOverflowScrolling: "touch" }}>
                  {dayGames.map((m) => <ResultRow key={m.id} m={m} resolve={(id) => ({ name: A(id).name, color: A(id).color })} onOpen={() => { setS({ heatDay: null }); openMatchSheet(m); }} />)}
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* HEAD-TO-HEAD SHEET — how two players have fared against AND alongside each other */}
      <AnimatePresence>
        {s.h2h && (() => {
          const { a, b } = s.h2h;
          if (!A(a) || !A(b)) return null;
          const close = () => setS({ h2h: null });
          return (
            <motion.div
              onClick={close}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
              style={{ position: "fixed", inset: 0, zIndex: 150, background: "rgba(0,0,0,.55)", backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
            >
              <motion.div
                onClick={(e) => e.stopPropagation()}
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={SOFT}
                style={{ width: "100%", maxWidth: 480, background: "#16191C", borderTop: "1px solid rgba(255,255,255,.1)", borderRadius: "22px 22px 0 0", padding: "18px 18px calc(24px + env(safe-area-inset-bottom))", maxHeight: "84vh", display: "flex", flexDirection: "column" }}
              >
                <div style={{ width: 38, height: 4, borderRadius: 99, background: "rgba(255,255,255,.15)", margin: "0 auto 16px", flexShrink: 0 }} />

                {/* Same comparison the Stats tab shows, pickers and all — the sheet just
                    arrives with both people already chosen. */}
                <div style={{ overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
                  <HeadToHead
                    cs={cs}
                    a={a}
                    b={b}
                    onPick={(side, id) => setS({ h2h: { ...s.h2h!, [side]: id } })}
                    onOpenPlayer={(id) => { close(); openProfile(id); }}
                    onOpenMatch={(id) => { close(); openMatchById(id); }}
                  />
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* RATING EXPLAINER SHEET — "why is my rating this number?" */}
      <AnimatePresence>
        {s.explainId && (
          <motion.div
            onClick={() => setS({ explainId: null })}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
            style={{ position: "fixed", inset: 0, zIndex: 150, background: "rgba(0,0,0,.55)", backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
          >
            <motion.div
              onClick={(e) => e.stopPropagation()}
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={SOFT}
              style={{ width: "100%", maxWidth: 480, background: "#16191C", borderTop: "1px solid rgba(255,255,255,.1)", borderRadius: "22px 22px 0 0", padding: "18px 18px calc(24px + env(safe-area-inset-bottom))", maxHeight: "86vh", display: "flex", flexDirection: "column" }}
            >
              <div style={{ width: 38, height: 4, borderRadius: 99, background: "rgba(255,255,255,.15)", margin: "0 auto 16px", flexShrink: 0 }} />
              <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 14, flexShrink: 0 }}>
                Why {A(s.explainId)?.name ?? ""} is {A(s.explainId)?.rating ?? ""}{seasonView ? ` ${period}` : ""}
              </div>
              <div style={{ overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
                <RatingExplainer
                  p={A(s.explainId)}
                  cs={cs}
                  resolve={A}
                  onOpenMatch={(id) => { setS({ explainId: null }); openMatchById(id); }}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* CHEMISTRY PAIR SHEET — the games a duo has played together */}
      <AnimatePresence>
        {s.chemPair && (() => {
          const cp = s.chemPair;
          const together = (t: string[]) => t.includes(cp.a) && t.includes(cp.b);
          const pairGames = [...scopedMatches]
            .filter((m) => together(m.teamA) || together(m.teamB))
            .sort((x, y) => y.order - x.order);
          const good = cp.chem >= 0;
          const openFromSheet = (id: string) => { setS({ chemPair: null }); openProfile(id); };
          return (
            <motion.div
              onClick={() => setS({ chemPair: null })}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
              style={{ position: "fixed", inset: 0, zIndex: 150, background: "rgba(0,0,0,.55)", backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
            >
              <motion.div
                onClick={(e) => e.stopPropagation()}
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={SOFT}
                style={{ width: "100%", maxWidth: 480, background: "#16191C", borderTop: "1px solid rgba(255,255,255,.1)", borderRadius: "22px 22px 0 0", padding: "18px 18px calc(24px + env(safe-area-inset-bottom))", maxHeight: "82vh", display: "flex", flexDirection: "column" }}
              >
                <div style={{ width: 38, height: 4, borderRadius: 99, background: "rgba(255,255,255,.15)", margin: "0 auto 16px", flexShrink: 0 }} />
                {/* pair header — tap a name to jump to that player's profile */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexShrink: 0 }}>
                  <div style={{ display: "flex", flexShrink: 0 }}>
                    <button onClick={() => openFromSheet(cp.a)} className={press} style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }} aria-label={`${A(cp.a).name} profile`}><Avatar name={A(cp.a).name} color={A(cp.a).color} size={38} ring="#16191C" /></button>
                    <button onClick={() => openFromSheet(cp.b)} className={press} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", marginLeft: -12 }} aria-label={`${A(cp.b).name} profile`}><Avatar name={A(cp.b).name} color={A(cp.b).color} size={38} ring="#16191C" /></button>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 17, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{A(cp.a).name} & {A(cp.b).name}</div>
                    <div style={{ fontSize: 12, color: C.dim, fontFamily: "var(--font-mono)", marginTop: 2 }}>
                      {cp.games} together · {cp.wins}–{cp.games - cp.wins}
                      <span style={{ color: good ? C.win : C.loss, fontWeight: 700 }}> · {good ? "+" : ""}{cp.chem} chem</span>
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 9, flexShrink: 0 }}>Games together</div>
                <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, WebkitOverflowScrolling: "touch" }}>
                  {pairGames.length === 0 ? (
                    <div style={{ fontSize: 13, color: C.dim, padding: "20px 2px" }}>No games together yet.</div>
                  ) : (
                    pairGames.map((m) => <ResultRow key={m.id} m={m} resolve={(id) => ({ name: A(id).name, color: A(id).color })} onOpen={() => { setS({ chemPair: null }); openMatchSheet(m); }} />)
                  )}
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* MATCH SHEET — tap any result: everyone sees the rating impact, admins can also
          fix the score or delete the game. Edits never auto-apply; they need Save. */}
      <AnimatePresence>
        {s.editMatch && (() => {
          const em = s.editMatch;
          // An optimistic local match is dropped from allMatches the instant its server copy
          // lands. Fall back to the persisted row that carries the same clientMatchId, so a
          // sheet open at that moment re-targets it instead of rendering blanks.
          const m =
            allMatches.find((x) => x.id === em.id) ??
            (em.clientMatchId ? allMatches.find((x) => x.clientMatchId === em.clientMatchId) : undefined);
          if (!m) return null;
          // Impact comes from the view the game counts in: this one, or — for tonight's games
          // opened from the matchmaker while a finished season is on screen — the season it's in.
          const mcs = inScope(scope, seasons, m.order) ? cs : standingsFor(seasonAt(seasons, m.order).n);
          const editable = adminOn && !m.id.startsWith("local-");
          const teamName = (ids: string[]) => ids.map((id) => A(id).name).join(" & ");
          const aWon = em.scoreA > em.scoreB;
          // Judged by the game's own season: a Season 1 score still has to reach 21.
          const to = m.to ?? 21;
          const valid = validWinBy2(em.scoreA, em.scoreB, to);
          // Retrospective rating impact: exactly what this game did to each player's rating,
          // read from the full replay so it's historically accurate.
          const entryFor = (id: string) => mcs.st[id]?.matches.find((mm) => mm.id === m.id);
          const impact = [...m.teamA, ...m.teamB].map((id) => {
            const st = mcs.st[id];
            const e = entryFor(id);
            return { id, name: st?.name ?? "?", color: st?.color ?? "#888", delta: e?.delta ?? 0, entry: e };
          });
          // Pre-game win chance for team A (their team's players all carry the same value).
          const eA = entryFor(m.teamA[0]);
          const probA = eA ? eA.winProb : null;
          // One line of "why", from the winners' point of view — the story of the game.
          const winnerEntry = entryFor((aWon ? m.teamA : m.teamB)[0]);
          const verdict = winnerEntry ? matchVerdict(winnerEntry) : null;
          const changed = editable && (em.scoreA !== m.scoreA || em.scoreB !== m.scoreB);
          const stepBtn: React.CSSProperties = { width: 34, height: 34, borderRadius: 10, background: C.raised, border: "1px solid rgba(255,255,255,.08)", color: C.fg, cursor: "pointer", touchAction: "none", display: "flex", alignItems: "center", justifyContent: "center" };
          const Step = ({ which, side }: { which: "A" | "B"; side: number }) => (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
              <button {...holdBind(() => setEditScore(which, -1))} className={`${press} spk-noselect`} aria-label="Lower" style={stepBtn}><MinusSmall /></button>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 30, fontWeight: 800, minWidth: 44, textAlign: "center", color: (which === "A" ? aWon : !aWon) ? C.accent : C.fg }}>{side}</div>
              <button {...holdBind(() => setEditScore(which, 1))} className={`${press} spk-noselect`} aria-label="Raise" style={stepBtn}><PlusSmall /></button>
            </div>
          );
          return (
            <motion.div
              onClick={closeMatchSheet}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
              style={{ position: "fixed", inset: 0, zIndex: 150, background: "rgba(0,0,0,.55)", backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
            >
              <motion.div
                onClick={(e) => e.stopPropagation()}
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={SOFT}
                style={{ width: "100%", maxWidth: 480, background: "#16191C", borderTop: "1px solid rgba(255,255,255,.1)", borderRadius: "22px 22px 0 0", padding: "18px 18px calc(28px + env(safe-area-inset-bottom))" }}
              >
                <div style={{ width: 38, height: 4, borderRadius: 99, background: "rgba(255,255,255,.15)", margin: "0 auto 16px" }} />
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 14 }}>
                  <span style={{ fontSize: 17, fontWeight: 800 }}>{editable ? "Edit result" : "Result"}</span>
                  <span style={{ fontSize: 12, color: C.dim, fontWeight: 600 }}>{m.date}</span>
                </div>
                {editable ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 10, marginBottom: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, textAlign: "center", color: aWon ? C.fg : C.muted }}>{teamName(m.teamA)}</div>
                    <div style={{ fontSize: 12, color: C.dim, fontWeight: 700 }}>vs</div>
                    <div style={{ fontSize: 13, fontWeight: 700, textAlign: "center", color: !aWon ? C.fg : C.muted }}>{teamName(m.teamB)}</div>
                    <Step which="A" side={em.scoreA} />
                    <div style={{ fontSize: 16, color: C.dim }}>–</div>
                    <Step which="B" side={em.scoreB} />
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 10, marginBottom: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, textAlign: "center", color: aWon ? C.fg : C.muted }}>{teamName(m.teamA)}</div>
                    <div style={{ fontSize: 12, color: C.dim, fontWeight: 700 }}>vs</div>
                    <div style={{ fontSize: 13, fontWeight: 700, textAlign: "center", color: !aWon ? C.fg : C.muted }}>{teamName(m.teamB)}</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 30, fontWeight: 800, textAlign: "center", color: aWon ? C.accent : C.fg }}>{em.scoreA}</div>
                    <div style={{ fontSize: 16, color: C.dim }}>–</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 30, fontWeight: 800, textAlign: "center", color: !aWon ? C.accent : C.fg }}>{em.scoreB}</div>
                  </div>
                )}
                {editable && !valid && <div style={{ fontSize: 11.5, color: C.loss, textAlign: "center", marginBottom: 12 }}>Score must reach {to} and win by 2.</div>}

                {probA != null && (
                  <div style={{ marginBottom: 16 }}>
                    <WinChanceBar probA={probA} aWon={aWon} nameA={teamName(m.teamA)} nameB={teamName(m.teamB)} />
                  </div>
                )}

                {impact.length > 0 && (
                  <div style={{ marginBottom: editable ? 16 : 4 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 8 }}>Rating impact</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {impact.map((p) => {
                        const mine = !!me && p.id === me;
                        const dc = p.delta > 0 ? C.win : p.delta < 0 ? C.loss : C.dim;
                        const open = s.whyId === p.id;
                        // The number is its own tap target: tapping it explains itself,
                        // tapping the name still goes to the profile. Two buttons in one
                        // row rather than one nested in the other — nesting is invalid
                        // HTML and swallows the inner tap on iOS.
                        // Suppressed mid-edit: the deltas on screen are stale until Save.
                        const canExplain = !!p.entry && !changed;
                        const partnerId = p.entry?.partner;
                        const partnerEntry = partnerId ? entryFor(partnerId) : undefined;
                        return (
                          <div
                            key={p.id}
                            style={{ background: mine ? "rgba(203,251,79,.07)" : C.surface, border: `1px solid ${mine ? "rgba(203,251,79,.25)" : "rgba(255,255,255,.06)"}`, borderRadius: 11, padding: "8px 11px" }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                              <button
                                onClick={() => { closeMatchSheet(); openProfile(p.id); }}
                                className={press}
                                style={{ display: "flex", alignItems: "center", gap: 9, flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer" }}
                              >
                                <Avatar name={p.name} color={p.color} size={24} />
                                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: C.fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}{mine && <span style={{ fontSize: 10, fontWeight: 700, color: C.accent, marginLeft: 6 }}>YOU</span>}</span>
                              </button>
                              <button
                                onClick={canExplain ? () => setS({ whyId: open ? null : p.id }) : undefined}
                                className={canExplain ? press : undefined}
                                aria-label={canExplain ? `Why ${p.name} got ${p.delta > 0 ? "+" : ""}${p.delta}` : undefined}
                                aria-expanded={canExplain ? open : undefined}
                                style={{ display: "flex", alignItems: "center", gap: 5, background: open ? "rgba(255,255,255,.06)" : "none", border: "none", borderRadius: 8, padding: canExplain ? "4px 7px" : 0, margin: canExplain ? "-4px -7px" : 0, cursor: canExplain ? "pointer" : "default" }}
                              >
                                <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 800, color: dc }}>{p.delta > 0 ? "+" : ""}{p.delta}</span>
                                {canExplain && (
                                  <motion.span animate={{ rotate: open ? 180 : 0 }} transition={SOFT} style={{ display: "flex", color: C.dim }}>
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                                  </motion.span>
                                )}
                              </button>
                            </div>
                            <AnimatePresence initial={false}>
                              {open && p.entry && (
                                <WhyDelta
                                  e={p.entry}
                                  partner={partnerEntry && partnerId ? { entry: partnerEntry, name: A(partnerId).name } : undefined}
                                />
                              )}
                            </AnimatePresence>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: 11, color: C.dimmer, marginTop: 8, lineHeight: 1.4 }}>
                      {changed
                        ? "Save changes to recalculate the impact."
                        : verdict ?? "How this game moved each player's rating."}
                      {!changed && impact.some((p) => p.entry) && " Tap any number to see why."}
                    </div>
                  </div>
                )}

                {editable && (
                  <>
                    <button onClick={saveEditMatch} disabled={!valid || s.editMatchSaving} className={press} style={{ width: "100%", height: 50, borderRadius: 14, background: valid ? C.accent : C.raised, border: "none", color: valid ? C.ink : C.dim, fontSize: 15, fontWeight: 800, cursor: valid ? "pointer" : "default", marginBottom: 10, opacity: s.editMatchSaving ? 0.6 : 1 }}>{s.editMatchSaving ? "Saving…" : "Save changes"}</button>
                    <button onClick={doDeleteMatch} disabled={s.editMatchSaving} className={press} style={{ width: "100%", height: 48, borderRadius: 14, background: "none", border: "1px solid rgba(255,107,107,.3)", color: C.loss, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Delete this game</button>
                  </>
                )}
                {/* An admin who hasn't unlocked sees why the controls aren't here, and the way in. */}
                {amAdmin && !adminOn && !m.id.startsWith("local-") && (
                  <div style={{ marginTop: 14, marginBottom: -18 }}>{renderAdminUnlock("Unlock admin to fix this score or delete the game.")}</div>
                )}
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* BOTTOM NAV — only for signed-in members; view-only is just the ladder */}
      {!guest && renderNav()}
    </div>
   </MotionConfig>
  );

  // ===================== render helpers =====================
  /** Who the pickers offer up front: anyone who's played lately, read from All time (see splitRoster). */
  function pickable() {
    return splitRoster(roster, standingsFor("all"));
  }
  /** The chip that unfolds whoever a picker is hiding. */
  function moreChip(n: number) {
    return (
      <button key="more" onClick={() => setS({ rosterAll: true })} className={press} style={{ borderRadius: 999, padding: "6px 13px", background: "transparent", border: "1px dashed rgba(255,255,255,.16)", color: C.dim, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>+{n} more</button>
    );
  }

  function renderLogin() {
    return (
      <div style={{ minHeight: "100dvh", background: "radial-gradient(120% 70% at 50% -10%, #16201A 0%, #0C0E10 55%)", display: "flex", flexDirection: "column", padding: "calc(64px + env(safe-area-inset-top)) 28px calc(40px + env(safe-area-inset-bottom))", maxWidth: 480, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: C.accent, display: "flex", alignItems: "center", justifyContent: "center" }}><NetIcon /></div>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.08 }}>
            <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-.01em" }}>East London</span>
            <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-.01em", color: C.accent }}>Roundnet</span>
          </div>
        </div>
        {s.loginStage === "pin" ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: 40 }}>
              <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-.03em", margin: 0 }}>Enter the code</h1>
              <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>One shared code unlocks the league</div>
              <div style={{ display: "flex", gap: 16, marginTop: 28 }}>
                {Array.from({ length: data.pinLength }, (_, i) => i).map((i) => {
                  const filled = i < s.pin.length;
                  return (
                    <motion.div key={i} animate={{ scale: filled ? [1, 1.4, 1] : 1, borderColor: filled ? C.accent : s.pinError ? "rgba(255,107,107,.6)" : "rgba(255,255,255,.25)", backgroundColor: filled ? C.accent : "rgba(0,0,0,0)", x: s.pinError ? [0, -5, 5, -4, 4, 0] : 0 }} transition={{ duration: 0.3 }} style={{ width: 14, height: 14, borderRadius: "50%", borderWidth: 1.5, borderStyle: "solid" }} />
                  );
                })}
              </div>
              {s.pinError && <div role="alert" style={{ fontSize: 12.5, color: C.loss, marginTop: 12, fontWeight: 600, textAlign: "center", maxWidth: 260 }}>{s.pinError}</div>}
            </div>
            <div style={{ marginTop: "auto", display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, maxWidth: 280, alignSelf: "center", width: "100%" }}>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"].map((k, i) => (
                k === "" ? <div key={i} /> : (
                  <motion.button key={i} onClick={() => pinPress(k)} whileTap={{ scale: 0.9, backgroundColor: k === "back" ? "rgba(255,255,255,.04)" : "#1B1F23" }} style={{ height: 64, borderRadius: 16, background: k === "back" ? "transparent" : C.surface, border: "1px solid rgba(255,255,255,.06)", color: C.fg, fontSize: 24, fontWeight: 600, fontFamily: "var(--font-mono)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{k === "back" ? "⌫" : k}</motion.button>
                )
              ))}
            </div>
            <button onClick={enterGuest} className={press} style={{ marginTop: 24, background: "none", border: "none", color: C.muted, fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><EyeIcon />Just browsing · view the ladder</button>
          </div>
        ) : (
          <div>
            <button onClick={pinBack} style={{ alignSelf: "flex-start", background: "none", border: "none", color: C.muted, fontSize: 14, fontWeight: 600, cursor: "pointer", margin: "18px 0 0", display: "flex", alignItems: "center", gap: 4 }}><Chevron dir="left" /> Back</button>
            <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-.03em", margin: "18px 0 4px", lineHeight: 1.05 }}>Who are you?</h1>
            <p style={{ color: C.muted, fontSize: 14, margin: "0 0 26px" }}>Tap your name to sign in.</p>
            <motion.div variants={listV} initial="initial" animate="animate" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {(s.rosterAll ? roster : pickable().regulars).map((p) => (
                <motion.button key={p.id} variants={rowV} whileTap={{ scale: 0.95 }} onClick={() => pickName(p.id)} style={{ display: "flex", alignItems: "center", gap: 11, background: C.surface, border: "1px solid rgba(255,255,255,.07)", borderRadius: 14, padding: "13px 12px", cursor: "pointer", textAlign: "left" }}>
                  <Avatar name={p.name} color={p.color} />
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{p.name}</span>
                </motion.button>
              ))}
            </motion.div>
            {!s.rosterAll && pickable().others.length > 0 && (
              <button onClick={() => setS({ rosterAll: true })} className={press} style={{ marginTop: 12, width: "100%", background: "none", border: "1px dashed rgba(255,255,255,.14)", borderRadius: 14, padding: 13, color: C.muted, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Not listed? Show {pickable().others.length} more
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderGate() {
    const gi: Record<string, [string, string]> = {
      log: ["Sign in to log a match", "Logging updates everyone's true score, so we need to know who you are."],
      me: ["Sign in for your profile", "Your rating, badges and match history live here once you sign in."],
    };
    const [gt, gb] = gi[s.screen] || ["Sign in", ""];
    return (
      <div style={{ padding: "70px 28px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ width: 66, height: 66, borderRadius: "50%", background: C.surface, border: "1px solid rgba(255,255,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20 }}><LockIcon /></div>
        <div style={{ fontSize: 20, fontWeight: 800 }}>{gt}</div>
        <div style={{ fontSize: 13.5, color: C.muted, marginTop: 8, maxWidth: 280, lineHeight: 1.5 }}>{gb}</div>
        <button onClick={startSignIn} className={press} style={{ marginTop: 24, height: 52, padding: "0 32px", borderRadius: 14, background: C.accent, border: "none", color: C.ink, fontSize: 15, fontWeight: 800, cursor: "pointer" }}>Sign in</button>
        <div style={{ fontSize: 12, color: C.dimmer, marginTop: 14 }}>You can keep browsing the ladder anytime.</div>
      </div>
    );
  }

  function FormDots({ form }: { form: ("W" | "L")[] }) {
    return <>{form.map((r, i) => <div key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: r === "W" ? C.win : C.loss }} />)}</>;
  }

  // Movement of a player since before the latest session: a number (+ = climbed),
  // "new" if they entered the rankings this session, or undefined when we lack history.
  function moveOf(p: PlayerStat): number | "new" | undefined {
    if (!prevRanks) return undefined;
    const pr = prevRanks[p.id];
    if (pr === undefined) return "new";
    return pr - (p.rank ?? 0);
  }

  function scoreLabel() {
    return <div style={{ fontSize: 8.5, fontWeight: 700, color: C.dimmer, letterSpacing: ".06em", marginTop: 1 }}>RATING</div>;
  }

  function renderLadder() {
    const recent = [...scopedMatches].sort((a, b) => b.order - a.order).slice(0, 3);
    // Anyone who hasn't played in DORMANT_DAYS drops out of the main ladder into a
    // collapsed "Resting" section, and computeStandings gives them no rank, so the visible
    // list numbers 1, 2, 3… with no gap. Their next game puts them straight back in.
    // Placing players rest too: someone four games in who vanished for a month belongs
    // under Resting (with the 🐣 where their rank would be), not in "Getting placed".
    const active = cs.ranked.filter((p) => p.active);
    const ranked = active.filter((p) => !isDormant(p, cs));
    const activePlacing = cs.placing.filter((p) => p.active);
    const resting = [...active, ...activePlacing].filter((p) => isDormant(p, cs));
    const placing = activePlacing.filter((p) => !isDormant(p, cs));
    // A season's ladder is the people who've played in it. Listing everyone who hasn't would just
    // be the rest of the roster (all of it, on a season's first night); the banner below says why
    // it's short. All time still lists brand-new players under "Not yet ranked".
    const unranked = scope === "all" ? cs.unranked.filter((p) => p.active) : [];
    return (
      <div style={{ padding: "14px 16px 0" }}>
        <SegTabs group="ladder" value={s.ladderView} onChange={(v) => setS({ ladderView: v })} options={[["podium", "Ranked"], ["table", "Table"], ["chemistry", "Chemistry"]] as const} />

        {/* A new season has an empty ladder by design. Say why, once, and point at how the
            last one finished — until somebody has played enough games to be ranked. */}
        {multiSeason && scope === current.n && ranked.length === 0 && s.ladderView !== "chemistry" && (
          <div style={{ background: "rgba(203,251,79,.05)", border: "1px solid rgba(203,251,79,.22)", borderRadius: 14, padding: "13px 14px", marginBottom: 14 }}>
            <div style={{ fontSize: 14.5, fontWeight: 800 }}>Fresh start</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
              Everyone&apos;s back on {START}. Ranked after {PROV_N} games.
            </div>
            <button onClick={() => setScope(current.n - 1)} className={press} style={{ marginTop: 9, padding: 0, background: "none", border: "none", color: C.accent, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
              {seasonName(current.n - 1)} final table →
            </button>
          </div>
        )}

        {s.ladderView === "podium" && (
          <LayoutGroup id="ladder-podium">
            <motion.div variants={listV} initial="initial" animate="animate" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {ranked.map((p) => {
                const top = p.rank === 1;
                return (
                  <motion.button key={p.id} layout="position" variants={rowV} whileTap={{ scale: 0.97 }} onClick={() => openProfile(p.id)} style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8, background: top ? "rgba(203,251,79,.05)" : C.surface, border: `1px solid ${top ? "rgba(203,251,79,.28)" : "rgba(255,255,255,.06)"}`, borderRadius: 14, padding: "11px 12px", cursor: "pointer", textAlign: "left", width: "100%" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 11, width: "100%" }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, width: 22, flexShrink: 0 }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 800, color: medalC(p.rank), lineHeight: 1 }}>{p.rank}</span>
                      <RankDelta d={moveOf(p)} />
                    </div>
                    <Avatar name={p.name} color={p.color} size={36} ring={p.rank && p.rank <= 3 ? medalC(p.rank) : undefined} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 15, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                        {top && <CrownIcon />}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4, rowGap: 3, marginTop: 5 }}>
                        <FormDots form={p.last5} />
                        <span style={{ fontSize: 11, color: C.dim, fontFamily: "var(--font-mono)", marginLeft: 4, whiteSpace: "nowrap", flexShrink: 0 }}>{p.wins}–{p.losses}</span>
                      </div>
                    </div>
                    <Sparkline hist={p.hist} />
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <AnimatedNumber value={p.rating} style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 19, fontWeight: 800, color: top ? C.accent : C.fg }} />
                      {scoreLabel()}
                    </div>
                    </div>
                    {/* Tier badge on its own full-width footer line — never squeezed by the sparkline/rating,
                        so even the longest name shows in full down to 320px. The likely rank range
                        sits at the far end of the same line when the server has one. */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 33 }}>
                      <TierChip rating={p.rating} provisional={p.provisional} />
                      {p.rankRange && p.rankRange[0] !== p.rankRange[1] && (
                        <span style={{ marginLeft: "auto", fontSize: 10, color: C.dimmer, fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>likely {ordinal(p.rankRange[0])}–{ordinal(p.rankRange[1])}</span>
                      )}
                    </div>
                  </motion.button>
                );
              })}
            </motion.div>
            {renderResting(resting)}
            {renderPlacing(placing)}
            {unranked.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 8, paddingLeft: 2 }}>Not yet ranked</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {unranked.map((p) => (
                    <button key={p.id} onClick={() => openProfile(p.id)} className={press} style={{ display: "flex", alignItems: "center", gap: 12, background: C.panel, border: "1px dashed rgba(255,255,255,.1)", borderRadius: 14, padding: "11px 13px", cursor: "pointer", textAlign: "left", width: "100%" }}>
                      <Avatar name={p.name} color={p.color} size={36} op={0.7} />
                      <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{p.name}</span>
                      <span style={{ fontSize: 12, color: C.dim }}>No games yet</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </LayoutGroup>
        )}

        {s.ladderView === "table" && (
          <>
            {renderTable(ranked)}
            {renderResting(resting)}
            {renderPlacing(placing)}
          </>
        )}

        {s.ladderView === "chemistry" && renderChem()}

        {recent.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, paddingLeft: 2 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".08em", textTransform: "uppercase" }}>Recent results</span>
              <button onClick={() => setS({ screen: "history", returnTo: "ladder" })} className={press} style={{ background: "none", border: "none", color: C.accent, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>See all →</button>
            </div>
            <motion.div layout style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <AnimatePresence initial={false}>
                {recent.map((m) => <ResultRow key={m.id} m={m} resolve={(id) => ({ name: A(id).name, color: A(id).color })} onOpen={() => openMatchSheet(m)} />)}
              </AnimatePresence>
            </motion.div>
          </div>
        )}
      </div>
    );
  }

  /**
   * The Table view. Six tight columns instead of the old cramped ones — PF/PA moved to the
   * profile and the Stats leaderboards, where they read far better than squeezed into 32px.
   * Headers sort; the left edge carries the tier colour so rank tier is visible without a chip.
   */
  function renderTable(rows: PlayerStat[]) {
    const cols = [
      { key: "rank" as const, label: "#", align: "left" as const, w: "20px", get: (p: PlayerStat) => -(p.rank ?? 999) },
      { key: "name" as const, label: "PLAYER", align: "left" as const, w: "1fr", get: () => 0 },
      { key: "games" as const, label: "GP", align: "center" as const, w: "26px", get: (p: PlayerStat) => p.games },
      { key: "wl" as const, label: "W–L", align: "center" as const, w: "44px", get: (p: PlayerStat) => p.wins },
      { key: "diff" as const, label: "+/−", align: "center" as const, w: "40px", get: (p: PlayerStat) => p.diff },
      { key: "rating" as const, label: "RATING", align: "right" as const, w: "50px", get: (p: PlayerStat) => p.rating },
    ];
    const grid = cols.map((c) => c.w).join(" ");
    const sortCol = cols.find((c) => c.key === s.ladderSort.key)!;
    const sorted = [...rows].sort((a, b) => {
      const d = sortCol.get(b) - sortCol.get(a);
      return s.ladderSort.dir === "desc" ? d : -d;
    });
    const toggle = (key: typeof s.ladderSort.key) =>
      setS({ ladderSort: key === s.ladderSort.key ? { key, dir: s.ladderSort.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" } });

    return (
      <div style={{ background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: grid, gap: 6, padding: "10px 13px", borderBottom: "1px solid rgba(255,255,255,.06)", position: "sticky", top: 0, background: C.surface, zIndex: 1 }}>
          {cols.map((c) => {
            const on = c.key === s.ladderSort.key;
            return (
              <button
                key={c.key}
                onClick={c.key === "name" ? undefined : () => toggle(c.key)}
                style={{ background: "none", border: "none", padding: 0, textAlign: c.align, fontSize: 10, fontWeight: 700, letterSpacing: ".04em", color: on ? C.accent : C.dimmer, cursor: c.key === "name" ? "default" : "pointer", whiteSpace: "nowrap" }}
              >
                {c.label}{on && c.key !== "name" && <span style={{ fontSize: 8 }}>{s.ladderSort.dir === "desc" ? " ▾" : " ▴"}</span>}
              </button>
            );
          })}
        </div>
        <motion.div variants={listV} initial="initial" animate="animate">
          {sorted.map((p) => (
            <motion.button
              key={p.id} layout="position" variants={rowV} whileTap={{ scale: 0.98 }} onClick={() => openProfile(p.id)}
              style={{ position: "relative", display: "grid", gridTemplateColumns: grid, gap: 6, alignItems: "center", padding: "11px 13px", border: "none", borderBottom: "1px solid rgba(255,255,255,.04)", background: p.rank === 1 ? "rgba(203,251,79,.045)" : "transparent", cursor: "pointer", textAlign: "left", width: "100%" }}
            >
              {/* tier colour as a hairline on the left edge — signal without a column */}
              <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 2, background: tierOf(p.rating, p.provisional).color, opacity: 0.75 }} />
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, color: p.rank === 1 ? C.accent : C.dim }}>
                {p.rank}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <Avatar name={p.name} color={p.color} size={24} />
                <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, textAlign: "center", color: C.num }}>{p.games}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, textAlign: "center", color: C.num }}>{p.wins}–{p.losses}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, textAlign: "center", color: p.diff > 0 ? C.win : p.diff < 0 ? C.loss : C.num }}>{p.diff > 0 ? "+" : ""}{p.diff}</div>
              <AnimatedNumber value={p.rating} style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 800, textAlign: "right", color: p.rank === 1 ? C.accent : C.fg }} />
            </motion.button>
          ))}
        </motion.div>
      </div>
    );
  }

  /**
   * Players with a rating but no rank yet: fewer than PROV_N games. They're listed by rating
   * but not numbered — the number would move ±3 places a game at this stage, which is exactly
   * why the league withholds it. The count is the thing to show: it's a progress bar.
   */
  function renderPlacing(placing: PlayerStat[]) {
    if (placing.length === 0) return null;
    return (
      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 8, paddingLeft: 2 }}>{pastSeason ? "Didn't place" : "Getting placed"}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {placing.map((p) => (
            <button key={p.id} onClick={() => openProfile(p.id)} className={press} style={{ display: "flex", alignItems: "center", gap: 11, background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, padding: "10px 13px", cursor: "pointer", textAlign: "left", width: "100%" }}>
              <span style={{ fontSize: 14, width: 22, textAlign: "center", flexShrink: 0 }}>{PROVISIONAL_TIER.icon}</span>
              <Avatar name={p.name} color={p.color} size={32} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                  {/* one pip per game toward the rank */}
                  <span style={{ display: "flex", gap: 3 }}>
                    {Array.from({ length: PROV_N }, (_, i) => (
                      <span key={i} style={{ width: 6, height: 6, borderRadius: 99, background: i < p.games ? C.accent : "rgba(255,255,255,.1)" }} />
                    ))}
                  </span>
                  <span style={{ fontSize: 10.5, color: C.dim, fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>{p.games}/{PROV_N} games</span>
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <AnimatedNumber value={p.rating} style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 17, fontWeight: 800, color: C.muted }} />
                {scoreLabel()}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  /**
   * Players who haven't shown up in DORMANT_DAYS. Collapsed by default so the ladder is
   * only the people actually playing. They hold no rank while resting (the ladder above has
   * no gaps) and keep their rating, so one game back slots them in where it puts them.
   */
  function renderResting(resting: PlayerStat[]) {
    if (resting.length === 0) return null;
    const open = s.restingOpen;
    return (
      <div style={{ marginTop: 16 }}>
        <button
          onClick={() => setS({ restingOpen: !open })}
          className={press}
          style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, background: C.panel, border: "1px solid rgba(255,255,255,.06)", borderRadius: 13, padding: "11px 13px", cursor: "pointer", textAlign: "left" }}
        >
          <span style={{ fontSize: 14 }}>💤</span>
          <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: C.muted }}>Resting</span>
          <span style={{ fontSize: 11.5, color: C.dimmer, fontFamily: "var(--font-mono)" }}>{resting.length}</span>
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={SPRING} style={{ display: "flex", color: C.dimmer }}><Chevron dir="right" /></motion.span>
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              transition={{ height: SOFT, opacity: { duration: 0.15 } }}
              style={{ overflow: "hidden" }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 7 }}>
                {resting.map((p) => (
                  <button key={p.id} onClick={() => openProfile(p.id)} className={press} style={{ display: "flex", alignItems: "center", gap: 11, background: C.surface, border: "1px solid rgba(255,255,255,.05)", borderRadius: 13, padding: "10px 13px", cursor: "pointer", textAlign: "left", width: "100%", opacity: 0.62 }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 700, color: C.dim, width: 20, flexShrink: 0, textAlign: "center" }}>{p.provisional ? PROVISIONAL_TIER.icon : "–"}</span>
                    <Avatar name={p.name} color={p.color} size={28} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                    <span style={{ fontSize: 10.5, color: C.dimmer, fontFamily: "var(--font-mono)", flexShrink: 0 }}>{daysSincePlayed(p, cs)}d</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 800, color: C.muted, flexShrink: 0 }}>{p.rating}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  function renderChem() {
    const rows = chemistryRanked(cs);
    if (rows.length === 0) return <div style={{ textAlign: "center", padding: "60px 20px", color: C.dim }}><div style={{ fontSize: 15, fontWeight: 700, color: C.num }}>Not enough games yet</div><div style={{ fontSize: 13, marginTop: 4 }}>Pairs need a few matches together first.</div></div>;
    return (
      <div>
        <div style={{ fontSize: 11.5, color: C.dim, marginBottom: 10, lineHeight: 1.4, padding: "0 2px" }}>Every pairing, best to worst. Chemistry is how much a duo over- or under-performs what their individual ratings predict.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((r) => {
            const good = r.chem >= 0;
            return (
              <motion.button
                key={`${r.a}${r.b}`}
                onClick={() => setS({ chemPair: r })}
                whileTap={{ scale: 0.98 }}
                style={{ display: "flex", alignItems: "center", gap: 11, background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, padding: "12px 13px", cursor: "pointer", textAlign: "left", width: "100%" }}
              >
                <div style={{ display: "flex", flexShrink: 0 }}>
                  <Avatar name={A(r.a).name} color={A(r.a).color} size={32} ring={C.surface} />
                  <div style={{ marginLeft: -10 }}><Avatar name={A(r.b).name} color={A(r.b).color} size={32} ring={C.surface} /></div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{A(r.a).name} & {A(r.b).name}</div>
                  <div style={{ fontSize: 11.5, color: C.dim, fontFamily: "var(--font-mono)", marginTop: 2 }}>{r.games} games · {r.wins}–{r.games - r.wins}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 800, color: good ? C.win : C.loss }}>{good ? "+" : ""}{r.chem}</div>
                  <div style={{ fontSize: 9.5, color: C.dim }}>CHEMISTRY</div>
                </div>
                <span style={{ flexShrink: 0, color: C.dim, display: "flex", marginLeft: -2 }}><Chevron dir="right" /></span>
              </motion.button>
            );
          })}
        </div>
      </div>
    );
  }

  function renderHistory() {
    const all = [...scopedMatches].sort((a, b) => b.order - a.order);
    if (all.length === 0) return <div style={{ padding: "60px 20px", textAlign: "center", color: C.dim }}>No games played yet.</div>;
    return (
      <motion.div layout style={{ padding: "14px 16px 0", display: "flex", flexDirection: "column", gap: 6 }}>
        <AnimatePresence initial={false}>
          {all.map((m) => <ResultRow key={m.id} m={m} resolve={(id) => ({ name: A(id).name, color: A(id).color })} onOpen={() => openMatchSheet(m)} />)}
        </AnimatePresence>
      </motion.div>
    );
  }

  function renderMatchmaker() {
    return (
      <div style={{ padding: "14px 16px 0" }}>
        <SegTabs group="mmtab" value={s.mmTab} onChange={(t) => setS({ mmTab: t })} options={[["tonight", "Tonight"], ["week", "This week"]] as const} />
        {s.mmTab === "tonight" ? renderTonight() : renderAvailability()}
      </div>
    );
  }

  function renderTonight() {
    const enough = presentIds.length >= 4;
    // Resting players fold away unless they've been tapped in.
    const folded = new Set(s.rosterAll ? [] : pickable().others.map((p) => p.id));
    const hiddenHere = roster.filter((p) => folded.has(p.id) && !s.present[p.id]).length;
    const todays = allMatches.filter((m) => m.date === "Today").sort((a, b) => b.order - a.order);
    const miniBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: 9, background: C.raised, border: "1px solid rgba(255,255,255,.08)", color: C.fg, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", touchAction: "none" };
    const matchById = new Map(allMatches.map((m) => [m.id, m]));
    // A played slot's score, in this slot's own team order — Team A is always the one on the
    // left, so it has to read the same way round as the pills above it. Only trust the score
    // if the match's teams genuinely correspond to the slot's, one way round or the other,
    // rather than assuming a swap and printing it reversed.
    const scoreOf = (g: { teamA: string[]; teamB: string[]; matchId: string | null }) => {
      const m = g.matchId ? matchById.get(g.matchId) : undefined;
      if (!m) return null;
      const same = (x: string[], y: string[]) => x.slice().sort().join() === y.slice().sort().join();
      if (same(m.teamA, g.teamA) && same(m.teamB, g.teamB)) return { a: m.scoreA, b: m.scoreB };
      if (same(m.teamA, g.teamB) && same(m.teamB, g.teamA)) return { a: m.scoreB, b: m.scoreA };
      return null;
    };
    // Tonight's plan as pasteable text, for dropping straight into the group chat.
    const planCopy = !plan ? "" : buildPlanText(
      plan.rounds.map((rd) => ({
        roundNo: rd.roundNo,
        out: rd.out,
        games: rd.games.map((g) => {
          const sc = scoreOf(g);
          return { courtNo: g.courtNo, teamA: g.teamA, teamB: g.teamB, result: sc ? `${sc.a}–${sc.b}` : g.matchId ? "played" : null };
        }),
      })),
      (id) => A(id)?.name ?? "?",
    );
    const copyPlan = async () => {
      try {
        await navigator.clipboard.writeText(planCopy);
        showToast("Plan copied");
      } catch {
        showToast("Couldn't copy");
      }
    };
    const pairOf = (a: string, b: string) => (a < b ? a + "|" + b : b + "|" + a);
    // The scheduler works from All time whatever season is on screen — "longest since they
    // partnered" is league history, and balance wants the best-informed skills — so its
    // reasoning is shown from the same place.
    const hcs = standingsFor("all");
    // Games since a pair last partnered, from the same league history the scheduler read.
    // Infinity = never partnered.
    const pairGap = (a: string, b: string) => {
      const p = hcs.pair[pairOf(a, b)];
      return p && p.games ? hcs.count - 1 - p.lastIdx : Infinity;
    };
    const foeGap = (a: string, b: string) => {
      const f = hcs.foe[pairOf(a, b)];
      return f && f.games ? hcs.count - 1 - f.lastIdx : Infinity;
    };
    const agoLabel = (g: number) => (g === Infinity ? "never" : g === 0 ? "last game" : `${g} ago`);
    // How overdue a matchup is, read off the same league history the scheduler used.
    const noveltyOf = (teamA: string[], teamB: string[]) => {
      const gA = pairGap(teamA[0], teamA[1]), gB = pairGap(teamB[0], teamB[1]);
      return { fresh: (gA === Infinity ? 1 : 0) + (gB === Infinity ? 1 : 0), gap: Math.min(gA, gB) };
    };
    // The FIRST round tonight's plan spends each pairing on — the grid's corner tag, and what
    // a later round compares against to say it's replaying a duo.
    const usedAt = new Map<string, number>();
    if (plan) for (const rd of plan.rounds) for (const g of rd.games) {
      for (const t of [g.teamA, g.teamB]) {
        const k = pairOf(t[0], t[1]);
        if (!usedAt.has(k)) usedAt.set(k, rd.roundNo);
      }
    }
    const mu = (id: string) => hcs.st[id]?.mu ?? 25;
    const diffOf = (teamA: string[], teamB: string[]) =>
      Math.round(Math.abs(mu(teamA[0]) + mu(teamA[1]) - mu(teamB[0]) - mu(teamB[1])) * 20);
    const hours = (mins: number) =>
      mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? " " + (mins % 60) + "m" : ""}`;
    const setRounds = (d: number) =>
      setSAll((prev) => ({ ...prev, mmRounds: Math.max(1, Math.min(MAX_ROUNDS, prev.mmRounds + d)) }));
    return (
      <>
        <div style={{ fontSize: 12.5, color: C.muted, margin: "0 0 12px", lineHeight: 1.4 }}>Tap who&apos;s at the court, then plan the night. We&apos;ll put together the pairings that haven&apos;t played in the longest time, rotate so nobody sits twice in a row, and even out everyone&apos;s games. Tap a game to log its score.</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
          {roster.filter((p) => !folded.has(p.id) || s.present[p.id]).map((p) => {
            const on = !!s.present[p.id];
            return (
              <motion.button key={p.id} onClick={() => togglePresent(p.id)} whileTap={{ scale: 0.93 }} animate={{ borderColor: on ? "rgba(203,251,79,.4)" : "rgba(255,255,255,.08)", backgroundColor: on ? "rgba(203,251,79,.1)" : "#15181B" }} transition={SPRING} style={{ display: "flex", alignItems: "center", gap: 8, borderRadius: 999, padding: "7px 13px 7px 8px", cursor: "pointer", borderWidth: 1, borderStyle: "solid" }}>
                <Avatar name={p.name} color={p.color} size={24} op={on ? 1 : 0.4} />
                <span style={{ fontSize: 13, fontWeight: 600, color: on ? C.fg : C.dim }}>{p.name}</span>
              </motion.button>
            );
          })}
          {hiddenHere > 0 && moreChip(hiddenHere)}
        </div>

        {/* How long the night is, and the button that commits it. Signed-in only — the plan
            is shared, so guests read it rather than rewrite it. */}
        {me && (
          <div style={{ background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 16, padding: 13, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 800 }}>{s.mmRounds} game{s.mmRounds === 1 ? "" : "s"}</div>
                <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>about {hours(s.mmRounds * gameMinutes(pointsTo))}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button {...holdBind(() => setRounds(-1))} className={`${press} spk-noselect`} aria-label="Fewer rounds" style={miniBtn}><MinusSmall size={16} /></button>
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 20, width: 26, textAlign: "center" }}>{s.mmRounds}</span>
                <button {...holdBind(() => setRounds(1))} className={`${press} spk-noselect`} aria-label="More rounds" style={miniBtn}><PlusSmall size={16} /></button>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              {(() => {
                const ok = enough && !s.mmPlanning && (!plan || planStale);
                const label = s.mmPlanning ? "…" : !plan ? "Generate plan" : planStale ? "Re-plan remaining" : "Plan is up to date";
                return (
                  <motion.button onClick={makePlan} whileTap={{ scale: ok ? 0.97 : 1 }} disabled={!ok} style={{ flex: 1, height: 42, borderRadius: 12, border: "none", fontSize: 13.5, fontWeight: 800, cursor: ok ? "pointer" : "default", background: ok ? C.accent : C.raised, color: ok ? C.ink : C.dimmer }}>{label}</motion.button>
                );
              })()}
              {plan && (
                <button onClick={dropPlan} disabled={s.mmPlanning} className={press} style={{ height: 42, padding: "0 14px", borderRadius: 12, border: "1px solid rgba(255,255,255,.08)", background: "transparent", color: C.dim, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Clear</button>
              )}
            </div>
            {!enough && <div style={{ fontSize: 11.5, color: C.dim, marginTop: 9 }}>Tap at least 4 names to plan a session.</div>}
            {plan && planStale && <div style={{ fontSize: 11.5, color: C.gold, marginTop: 9 }}>Line-up changed. Re-planning rewrites the rounds you haven&apos;t started.</div>}
          </div>
        )}

        {plan ? (
          <div>
            {(() => {
              const totals = plan.roster.map((id) => plan.perPlayer[id]?.games ?? 0);
              const sits = plan.roster.map((id) => plan.perPlayer[id]?.sits ?? 0);
              const gLo = Math.min(...totals), gHi = Math.max(...totals);
              const sLo = Math.min(...sits), sHi = Math.max(...sits);
              const gTxt = gLo === gHi ? `each plays ${gLo}` : `each plays ${gLo}–${gHi}`;
              const sTxt = sHi === 0 ? "nobody sits" : sLo === sHi ? `sits ${sLo}` : `sits ${sLo}–${sHi}`;
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "2px 2px 12px", lineHeight: 1.45 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 800, color: C.fg }}>{plan.played} of {plan.games.length} played</span>
                  <span style={{ fontSize: 12, color: C.muted }}>{gTxt}, {sTxt}</span>
                  {/* Plain-text copy of the whole plan, for pasting into the group chat.
                      Everyone gets it, guests included — it only reads the plan. */}
                  <button onClick={copyPlan} className={press} style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, height: 28, padding: "0 11px", borderRadius: 9, background: C.raised, border: "1px solid rgba(255,255,255,.08)", color: C.fg, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
                    <CopyIcon />Copy
                  </button>
                </div>
              );
            })()}

            {/* The grid the scheduler works from: who hasn't partnered in the longest. Folded
                away by default — it's the reasoning behind the plan, not the plan itself. */}
            {(() => {
              const who = plan.roster.filter((id) => hcs.st[id]);
              if (who.length < 2) return null;
              const gaps = who.flatMap((a, i) => who.slice(i + 1).map((b) => pairGap(a, b))).filter((g) => g !== Infinity);
              const maxGap = Math.max(1, ...gaps);
              return (
                <div style={{ background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 16, marginBottom: 10, overflow: "hidden" }}>
                  <button onClick={() => setS({ mmGridOpen: !s.mmGridOpen })} className={press} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "13px 14px", background: "none", border: "none", cursor: "pointer", color: C.fg, textAlign: "left" }}>
                    <span>
                      <span style={{ fontSize: 13, fontWeight: 800 }}>Who&apos;s overdue</span>
                      <span style={{ fontSize: 11.5, color: C.dim, marginLeft: 8 }}>games since each pair last teamed up</span>
                    </span>
                    <motion.span animate={{ rotate: s.mmGridOpen ? 90 : 0 }} transition={SPRING} style={{ color: C.dim, display: "flex" }}><Chevron dir="right" /></motion.span>
                  </button>
                  <AnimatePresence initial={false}>
                    {s.mmGridOpen && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SOFT} style={{ overflow: "hidden" }}>
                        <div style={{ padding: "0 14px 14px", overflowX: "auto" }}>
                          <div style={{ display: "grid", gridTemplateColumns: `auto repeat(${who.length}, minmax(34px, 1fr))`, gap: 3, minWidth: who.length * 40 + 34 }}>
                            <div />
                            {who.map((id) => (
                              <div key={"h" + id} style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: C.dim, textAlign: "center", paddingBottom: 3, overflow: "hidden", textOverflow: "ellipsis" }}>{A(id)?.initial ?? "?"}</div>
                            ))}
                            {who.map((a) => (
                              <Fragment key={"r" + a}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, paddingRight: 7, height: 34 }}>
                                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: A(a)?.color ?? C.dim, flexShrink: 0 }} />
                                  <span style={{ fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>{A(a)?.name ?? "?"}</span>
                                </div>
                                {who.map((b) => {
                                  if (a === b) return <div key={a + b} style={{ borderRadius: 7, background: C.raised, opacity: 0.3 }} />;
                                  const gap = pairGap(a, b);
                                  const never = gap === Infinity;
                                  const t = never ? 1 : Math.min(1, gap / maxGap);
                                  const round = usedAt.get(pairOf(a, b));
                                  return (
                                    <div key={a + b} title={`${A(a)?.name} + ${A(b)?.name} · ${never ? "never partnered" : agoLabel(gap)}${round !== undefined ? ` · round ${round + 1}` : ""}`}
                                      style={{ position: "relative", height: 34, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 700,
                                        background: never ? "transparent" : `rgba(203,251,79,${(0.05 + 0.92 * Math.pow(t, 1.35)).toFixed(3)})`,
                                        border: never ? `1px solid ${C.accent}` : "1px solid transparent",
                                        color: never ? C.accent : t > 0.5 ? C.ink : C.muted }}>
                                      {never ? "new" : gap}
                                      {round !== undefined && <span style={{ position: "absolute", top: 1, right: 3, fontSize: 7.5, fontWeight: 800, opacity: 0.62 }}>R{round + 1}</span>}
                                    </div>
                                  );
                                })}
                              </Fragment>
                            ))}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 11, fontSize: 11, color: C.dim, flexWrap: "wrap" }}>
                            <span>just played</span>
                            <span style={{ width: 74, height: 8, borderRadius: 99, background: "linear-gradient(90deg,rgba(203,251,79,.05),rgba(203,251,79,.97))" }} />
                            <span>long overdue</span>
                            <span style={{ marginLeft: "auto" }}><b style={{ color: C.accent, fontFamily: "var(--font-mono)", fontSize: 10 }}>R3</b> = round it&apos;s used</span>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })()}

            <motion.div key="plan" variants={listV} initial="initial" animate="animate" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {plan.rounds.map((rd, i) => {
                const prev = i > 0 ? plan.rounds[i - 1] : null;
                return (
                  <motion.div key={rd.roundNo} layout variants={rowV} style={{ background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 16, padding: 13 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
                      <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: ".04em", color: C.accent }}>ROUND {rd.roundNo + 1}</span>
                      <span style={{ fontSize: 11, color: C.dim }}>{rd.out.length ? "Sit: " + rd.out.map((id) => A(id)?.name ?? "?").join(", ") : "Everyone plays"}</span>
                    </div>
                    {rd.games.map((g, ci) => {
                      const m = g.matchId ? matchById.get(g.matchId) : undefined;
                      const done = !!g.matchId;
                      const diff = diffOf(g.teamA, g.teamB);
                      const { fresh, gap } = noveltyOf(g.teamA, g.teamB);
                      const bl = diff < 25 ? "Even" : diff < 60 ? "Slight edge" : "Lopsided";
                      const bc = diff < 25 ? C.win : diff < 60 ? C.gold : C.loss;
                      const bb = diff < 25 ? "rgba(92,211,125,.12)" : diff < 60 ? "rgba(255,207,92,.12)" : "rgba(255,107,107,.12)";
                      const backIn = prev ? [...g.teamA, ...g.teamB].filter((id) => prev.out.includes(id)) : [];
                      const why = s.mmWhyKey === g.id;
                      const sc = scoreOf(g);
                      // Played slots open their result; unplayed ones hand the line-up to the Log
                      // screen, which is the only place a score gets entered now.
                      const openRow = done && m ? () => openMatchSheet(m) : me ? () => logPlanGame(g) : undefined;
                      return (
                        <div
                          key={g.id}
                          onClick={openRow}
                          style={{ opacity: done ? 0.45 : 1, cursor: openRow ? "pointer" : "default", marginTop: ci ? 11 : 0, paddingTop: ci ? 11 : 0, borderTop: ci ? "1px solid rgba(255,255,255,.06)" : "none" }}
                        >
                          {rd.games.length > 1 && (
                            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", color: C.dimmer, marginBottom: 6 }}>COURT {g.courtNo + 1}</div>
                          )}
                          <div style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: done ? "line-through" : "none" }}>
                            <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 5 }}>{g.teamA.map((id) => <Pill key={id} id={id} A={A} />)}</div>
                            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: C.dim, fontWeight: 700 }}>vs</span>
                            <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 5, justifyContent: "flex-end" }}>{g.teamB.map((id) => <Pill key={id} id={id} A={A} />)}</div>
                          </div>
                          <div style={{ display: "flex", gap: 7, marginTop: 9, alignItems: "center", flexWrap: "wrap" }}>
                            {done ? (
                              <span style={{ fontSize: 11.5, fontWeight: 800, color: C.win, fontFamily: "var(--font-mono)" }}>
                                {sc === null ? "✓ played" : `✓ ${sc.a}–${sc.b}`}
                              </span>
                            ) : (
                              <>
                                <span style={{ fontSize: 11, fontWeight: 700, color: bc, background: bb, borderRadius: 6, padding: "3px 8px" }}>{bl}</span>
                                {fresh > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: C.num, background: "rgba(255,255,255,.04)", borderRadius: 6, padding: "3px 8px" }}>{fresh === 2 ? "Both new duos" : "New duo"}</span>}
                                {fresh === 0 && gap >= 8 && <span style={{ fontSize: 11, fontWeight: 600, color: C.num, background: "rgba(255,255,255,.04)", borderRadius: 6, padding: "3px 8px" }}>Overdue · {gap} games</span>}
                                {backIn.length > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: C.dim }}>↩ {backIn.map((id) => A(id)?.name ?? "?").join(", ")} back on</span>}
                                {/* the row itself is tappable now, so inner buttons must not bubble */}
                                <button onClick={(e) => { e.stopPropagation(); setS({ mmWhyKey: why ? null : g.id }); }} className={press} style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, color: why ? C.fg : C.dim, background: "none", border: "none", cursor: "pointer" }}>{why ? "Hide" : "Why?"}</button>
                                {me && (
                                  <span style={{ fontSize: 11, fontWeight: 700, color: C.accent }}>Log score →</span>
                                )}
                              </>
                            )}
                          </div>

                          {/* Why this game, in the scheduler's own order of priorities. Reading it
                              must not count as tapping the row — that would bounce you to the Log
                              screen and throw away whatever was in the form. */}
                          <AnimatePresence initial={false}>
                            {why && (
                              <motion.div onClick={(e) => e.stopPropagation()} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SOFT} style={{ overflow: "hidden", cursor: "default" }}>
                                <div style={{ marginTop: 11, paddingTop: 11, borderTop: "1px solid rgba(255,255,255,.06)", display: "flex", flexDirection: "column", gap: 7 }}>
                                  {[g.teamA, g.teamB].map((t, ti) => {
                                    const pg = pairGap(t[0], t[1]);
                                    const tonight = usedAt.get(pairOf(t[0], t[1]));
                                    const repeat = tonight !== undefined && tonight < rd.roundNo;
                                    return (
                                      <div key={ti} style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", fontSize: 11.5 }}>
                                        <span style={{ color: C.dim, fontFamily: "var(--font-mono)", fontSize: 10, width: 34 }}>{ti ? "TEAM B" : "TEAM A"}</span>
                                        <span style={{ fontWeight: 600 }}>{t.map((id) => A(id)?.name ?? "?").join(" + ")}</span>
                                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: pg === Infinity ? C.accent : C.muted, background: "rgba(255,255,255,.04)", borderRadius: 6, padding: "2px 7px" }}>
                                          {pg === Infinity ? "never partnered" : `last teamed up ${agoLabel(pg)}`}
                                        </span>
                                        {repeat && <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: C.gold }}>replays round {tonight + 1}</span>}
                                      </div>
                                    );
                                  })}
                                  {(() => {
                                    const cross = g.teamA.flatMap((a) => g.teamB.map((b) => foeGap(a, b)));
                                    const newFoes = cross.filter((x) => x === Infinity).length;
                                    const freshest = Math.min(...cross.filter((x) => x !== Infinity));
                                    return (
                                      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", fontSize: 11.5, color: C.muted }}>
                                        <span style={{ color: C.dim, fontFamily: "var(--font-mono)", fontSize: 10, width: 34 }}>FACED</span>
                                        <span>
                                          {newFoes === 4 ? "none of them have played each other" :
                                            newFoes > 0 ? `${newFoes} of the 4 match-ups are new` :
                                            `closest match-up was ${agoLabel(freshest)}`}
                                        </span>
                                      </div>
                                    );
                                  })()}
                                  <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", fontSize: 11.5, color: C.muted }}>
                                    <span style={{ color: C.dim, fontFamily: "var(--font-mono)", fontSize: 10, width: 34 }}>TEAMS</span>
                                    <span>{diff < 25 ? "evenly matched" : diff < 60 ? "slight edge on paper" : "lopsided on paper"} · {diff} pts apart</span>
                                  </div>
                                  <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.45, marginTop: 2 }}>
                                    Chosen from the ways this round&rsquo;s players could be split: longest-overdue
                                    pairings first, avoiding anyone who has already partnered tonight, with even
                                    teams last. The grid up top shows every pair.
                                  </div>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    })}
                  </motion.div>
                );
              })}
            </motion.div>
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: "40px 20px", color: C.dim }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.num }}>{enough ? "No plan yet tonight" : "Need at least 4 players"}</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>{enough ? (me ? "Hit Generate plan above." : "Someone signed in can set one up.") : "Tap more names above."}</div>
          </div>
        )}

        {todays.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 8, paddingLeft: 2 }}>Today&apos;s games</div>
            <motion.div layout style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <AnimatePresence initial={false}>
                {todays.map((m) => <ResultRow key={m.id} m={m} resolve={(id) => ({ name: A(id).name, color: A(id).color })} onOpen={() => openMatchSheet(m)} />)}
              </AnimatePresence>
            </motion.div>
          </div>
        )}
      </>
    );
  }

  function renderAvailability() {
    return (
      <>
        <div style={{ fontSize: 12.5, color: C.muted, margin: "0 0 12px", lineHeight: 1.4 }}>Tap the days you can play. Everyone sees who&apos;s free.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {data.days.map((day) => {
            const d = new Date(day + "T00:00:00");
            const weekday = d.toLocaleDateString("en-GB", { weekday: "short" });
            const dlabel = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
            const others = (data.availabilityByDay[day] || []).filter((id) => id !== me);
            const meFree = !!s.myAvail[day];
            const freeIds = [...others, ...(meFree && me ? [me] : [])];
            return (
              <div key={day} style={{ display: "flex", alignItems: "center", gap: 10, background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 12, padding: "10px 12px" }}>
                <div style={{ width: 46, flexShrink: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{weekday}</div>
                  <div style={{ fontSize: 10.5, color: C.dim }}>{dlabel}</div>
                </div>
                <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 4, minHeight: 24, alignItems: "center" }}>
                  {freeIds.length === 0 ? <span style={{ fontSize: 12, color: "#4A5056" }}>nobody yet</span> : freeIds.map((id) => <Avatar key={id} name={A(id).name} color={A(id).color} size={22} />)}
                </div>
                {me ? (
                  <button onClick={() => toggleAvail(day)} className={press} style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, borderRadius: 999, padding: "6px 12px", cursor: "pointer", border: `1px solid ${meFree ? "rgba(203,251,79,.4)" : "rgba(255,255,255,.1)"}`, background: meFree ? C.accent : "transparent", color: meFree ? C.ink : C.muted }}>{meFree ? "I'm in" : "Free?"}</button>
                ) : (
                  <span style={{ fontSize: 11, color: C.dim, flexShrink: 0 }}>{freeIds.length}</span>
                )}
              </div>
            );
          })}
        </div>
      </>
    );
  }

  // The reward screen. One phone gets passed round a court, so this shows the whole game —
  // all four players, what each of them gained or lost, where they landed on the ladder, and
  // the one thing that made their night. Nothing here explains how ratings work; every line
  // is about what these four just did. Confetti only if you logged your own win.
  function renderLogResult(r: LogResult) {
    const nameOf = (ids: string[]) => ids.map((id) => A(id)?.name ?? "?").join(" & ");
    const aWon = r.scoreA > r.scoreB;
    const mine = me ? r.players.find((p) => p.id === me) : undefined;
    const probOf = (p: LogResultPlayer) => (p.team === "A" ? r.winProbA : 1 - r.winProbA);

    // The single most notable thing that happened to this player, rarest first. Null when a
    // game was simply a game — better to say nothing than to pad every row out.
    const headlineOf = (p: LogResultPlayer): { text: string; color: string } | null => {
      const partner = r.players.find((x) => x.team === p.team && x.id !== p.id);
      const prob = probOf(p);
      if (!p.provAfter && p.tierAfter.name !== p.tierBefore.name)
        return { text: `${p.tierAfter.icon} ${p.tierAfter.name}`, color: C.gold };
      if (p.provBefore && !p.provAfter) return { text: "Placed! You've got a rank now", color: C.accent };
      if (p.won && prob < 0.42) return { text: `${Math.round(prob * 100)}% underdog — pulled it off`, color: C.gold };
      // A win that only earned the minimum is worth a line, or the small + reads like a bug.
      if (p.held) return { text: "Won, but under par", color: C.dim };
      if (p.newPeak) return { text: r.seasonal ? "Season-high rating" : "Career-high rating", color: C.gold };
      if (p.newBadges.length) return { text: `${p.newBadges[0].icon} ${p.newBadges[0].label}`, color: C.accent };
      if (p.streak.type === "W" && p.streak.count >= 3) return { text: `${p.streak.count} wins in a row`, color: C.win };
      if (p.streak.type === "L" && p.streak.count >= 3) return { text: `${p.streak.count} straight losses`, color: C.loss };
      if (p.won && p.partnerRun >= 2 && partner) return { text: `${p.partnerRun} straight with ${partner.name}`, color: C.win };
      if (p.tonight.games >= 2) return { text: `${p.tonight.wins}–${p.tonight.games - p.tonight.wins} tonight`, color: C.dim };
      return null;
    };

    const dCol = (d: number) => (d > 0 ? C.win : d < 0 ? C.loss : C.dim);
    // One card per player, in team order, winners first. The rating is the hero figure and
    // counts up from where it was; the ladder slot sits under it.
    const card = (p: LogResultPlayer, i: number) => {
      const hl = headlineOf(p);
      const isMe = p.id === me;
      return (
        <motion.div
          key={p.id}
          variants={{ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0, transition: SOFT } }}
          style={{
            display: "flex", alignItems: "center", gap: 10,
            background: isMe ? "rgba(203,251,79,.07)" : C.surface,
            border: `1px solid ${isMe ? "rgba(203,251,79,.28)" : "rgba(255,255,255,.06)"}`,
            borderRadius: 13, padding: "8px 12px",
          }}
        >
          <Avatar name={p.name} color={p.color} size={30} ring={p.won ? C.accent : undefined} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
              {isMe && <span style={{ fontSize: 9.5, fontWeight: 800, color: C.ink, background: C.accent, borderRadius: 4, padding: "1px 4px" }}>YOU</span>}
            </div>
            <div style={{ fontSize: 11, color: hl ? hl.color : C.dimmer, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {hl ? hl.text : p.won ? "Win" : "Loss"}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "flex-end", gap: 6 }}>
              <AnimatedNumber
                value={p.ratingAfter} from={p.ratingBefore} duration={1}
                style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 800, lineHeight: 1, color: C.fg }}
              />
              <motion.span
                initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ ...BOUNCE, delay: 0.5 + i * 0.06 }}
                style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 800, color: dCol(p.delta) }}
              >
                {p.delta > 0 ? "+" : ""}{p.delta}
              </motion.span>
            </div>
            {p.rankAfter ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 5, marginTop: 3 }}>
                {!!p.rankBefore && p.rankBefore !== p.rankAfter && (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: C.dimmer, textDecoration: "line-through" }}>#{p.rankBefore}</span>
                )}
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, color: C.muted }}>#{p.rankAfter}</span>
                <RankDelta d={p.rankBefore ? p.rankBefore - p.rankAfter : "new"} />
              </div>
            ) : (
              // Still placing: say how far off the rank is rather than printing "#undefined".
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: C.dimmer, marginTop: 3 }}>
                placing · {PROV_N - p.gamesAfter} more
              </div>
            )}
          </div>
        </motion.div>
      );
    };

    const winners = r.players.filter((p) => p.won);
    const losers = r.players.filter((p) => !p.won);
    // Sized to land inside one phone screen without scrolling — four cards plus the header is
    // the budget, so every margin here is deliberate rather than comfortable.
    return (
      <div style={{ position: "relative", padding: "6px 16px 0" }}>
        <motion.button
          onClick={dismissLogResult} aria-label="Done" whileTap={{ scale: 0.9 }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}
          style={{ position: "absolute", top: 2, right: 12, zIndex: 3, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 999, background: "none", border: "none", color: C.dim, cursor: "pointer" }}
        >
          <CloseIcon />
        </motion.button>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={SOFT} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ position: "relative", width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {/* you logged your own win — take a moment */}
            {mine?.won && <Confetti />}
            {[0, 0.18].map((delay, i) => (
              <motion.div
                key={i}
                initial={{ scale: 0.4, opacity: 0.7 }} animate={{ scale: 1.8, opacity: 0 }}
                transition={{ duration: 1, ease: "easeOut", delay, repeat: Infinity, repeatDelay: 0.9 }}
                style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `2px solid ${C.accent}` }}
              />
            ))}
            <motion.div
              initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ ...BOUNCE, delay: 0.05 }}
              style={{ position: "relative", zIndex: 2, width: 44, height: 44, borderRadius: "50%", background: C.accent, display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <motion.span initial={{ scale: 0, rotate: -25 }} animate={{ scale: 1, rotate: 0 }} transition={{ ...BOUNCE, delay: 0.22 }} style={{ display: "flex" }}><CheckIcon size={26} /></motion.span>
            </motion.div>
          </div>

          {/* the result in names, not "Team A" */}
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SOFT, delay: 0.18 }} style={{ textAlign: "center", marginTop: 10 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: aWon ? C.accent : C.muted }}>{nameOf(r.teamA)}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 30, fontWeight: 800, margin: "1px 0", letterSpacing: "-.02em", lineHeight: 1.15 }}>
              <span style={{ color: aWon ? C.accent : C.fg }}>{r.scoreA}</span>
              <span style={{ color: "#3A4046", margin: "0 8px" }}>–</span>
              <span style={{ color: !aWon ? C.accent : C.fg }}>{r.scoreB}</span>
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: !aWon ? C.accent : C.muted }}>{nameOf(r.teamB)}</div>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SOFT, delay: 0.28 }} style={{ width: "100%", marginTop: 12, background: C.panel, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, padding: "11px 13px" }}>
            <WinChanceBar probA={r.winProbA} aWon={aWon} nameA={nameOf(r.teamA)} nameB={nameOf(r.teamB)} />
          </motion.div>

          <motion.div
            variants={{ animate: { transition: { staggerChildren: 0.07, delayChildren: 0.38 } } }} initial="initial" animate="animate"
            style={{ width: "100%", marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}
          >
            {[...winners, ...losers].map(card)}
          </motion.div>
        </motion.div>
      </div>
    );
  }

  function renderLog() {
    if (s.logSuccess && s.lastResult) return renderLogResult(s.lastResult);

    const ready = s.teamA.length === 2 && s.teamB.length === 2 && validWinBy2(s.scoreA, s.scoreB, pointsTo);
    const winner: "A" | "B" | null = s.scoreA > s.scoreB ? "A" : s.scoreB > s.scoreA ? "B" : null;
    const loser: "A" | "B" | null = winner === "A" ? "B" : winner === "B" ? "A" : null;

    // Tonight's next unplayed round: one tap fills the form, so the common path never
    // touches the chip list at all.
    const nextUp = (() => {
      if (!plan) return null;
      for (const rd of plan.rounds) {
        const open = rd.games.filter((g) => !g.matchId);
        if (open.length) return { roundNo: rd.roundNo, games: open };
      }
      return null;
    })();

    // Whoever's at the court comes first — the four you want are then always in reach,
    // and the rest of a growing roster drops below the fold instead of on top of it.
    const hereIds = new Set(plan ? plan.roster : presentIds);
    // Resting players fold away unless they're already here or on a team.
    const folded = new Set(s.rosterAll ? [] : pickable().others.map((p) => p.id));
    const shown = (p: { id: string }) => !folded.has(p.id) || hereIds.has(p.id) || s.teamA.includes(p.id) || s.teamB.includes(p.id);
    const here = (hereIds.size ? roster.filter((p) => hereIds.has(p.id)) : roster).filter(shown);
    const away = hereIds.size ? roster.filter((p) => !hereIds.has(p.id)).filter(shown) : [];
    const hidden = roster.filter((p) => !shown(p)).length;

    const chip = (p: { id: string; name: string; color: string }, dim: boolean) => {
      const inA = s.teamA.includes(p.id), inB = s.teamB.includes(p.id);
      const tagged = inA || inB;
      return (
        <motion.button
          key={p.id} onClick={() => assign(p.id)} whileTap={{ scale: 0.92 }} layout
          animate={{ borderColor: tagged ? "rgba(203,251,79,.35)" : "rgba(255,255,255,.07)", backgroundColor: tagged ? "#1B2018" : "#15181B", opacity: dim && !tagged ? 0.55 : 1 }}
          transition={SPRING}
          style={{ display: "flex", alignItems: "center", gap: 7, borderRadius: 999, padding: "6px 12px 6px 6px", cursor: "pointer", borderWidth: 1, borderStyle: "solid" }}
        >
          <Avatar name={p.name} color={p.color} size={24} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
          <AnimatePresence>
            {tagged && <motion.span key={inA ? "A" : "B"} initial={{ scale: 0, width: 0, marginLeft: 0 }} animate={{ scale: 1, width: 16, marginLeft: 0 }} exit={{ scale: 0, width: 0 }} transition={BOUNCE} style={{ fontSize: 10, fontWeight: 800, color: C.ink, background: inA ? C.accent : C.silver, borderRadius: 5, height: 16, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>{inA ? "A" : "B"}</motion.span>}
          </AnimatePresence>
        </motion.button>
      );
    };

    const col = (team: "A" | "B") => {
      const val = team === "A" ? s.scoreA : s.scoreB;
      const isWin = winner === team;
      return (
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: team === "A" ? C.accent : C.silver, marginBottom: 8, letterSpacing: ".05em" }}>TEAM {team}</div>
          <motion.button
            onClick={() => declareWinner(team)} whileTap={{ scale: 0.9 }} animate={{ scale: isWin ? 1.06 : 1 }} transition={SPRING}
            title="Tap to make winner" className="spk-noselect"
            style={{ display: "block", width: "100%", border: "none", background: "transparent", cursor: "pointer", padding: 0 }}
          >
            <AnimatedNumber value={val} duration={0.35} style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 48, fontWeight: 800, lineHeight: 1, color: isWin ? C.accent : C.fg, transition: "color .2s" }} />
          </motion.button>
          <div style={{ marginTop: 7, minHeight: 13 }}>
            <AnimatePresence mode="wait" initial={false}>
              {isWin ? (
                <motion.span key="win" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={BOUNCE} style={{ display: "block", fontSize: 10, fontWeight: 800, letterSpacing: ".06em", color: C.accent }}>WINNER</motion.span>
              ) : winner === null ? (
                <motion.span key="tap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ display: "block", fontSize: 10, fontWeight: 700, letterSpacing: ".06em", color: C.dimmer }}>TAP TO WIN</motion.span>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      );
    };

    return (
      <div style={{ padding: "14px 16px 0" }}>
        {nextUp && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 8 }}>Next up · round {nextUp.roundNo + 1}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {nextUp.games.map((g) => {
                const on = s.logPlanGameId === g.id;
                return (
                  <motion.button
                    key={g.id}
                    onClick={() => (on ? setS({ ...clearLog }) : logPlanGame(g))}
                    whileTap={{ scale: 0.98 }}
                    animate={{ borderColor: on ? "rgba(203,251,79,.45)" : "rgba(255,255,255,.07)", backgroundColor: on ? "#1B2018" : C.surface }}
                    transition={SPRING}
                    style={{ display: "flex", alignItems: "center", gap: 9, borderRadius: 14, borderWidth: 1, borderStyle: "solid", padding: "10px 12px", cursor: "pointer", textAlign: "left", width: "100%" }}
                  >
                    <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: C.fg }}>
                      {g.teamA.map((id) => A(id)?.name ?? "?").join(" & ")}
                      <span style={{ color: C.dim, fontWeight: 700, margin: "0 6px" }}>vs</span>
                      {g.teamB.map((id) => A(id)?.name ?? "?").join(" & ")}
                    </div>
                    {nextUp.games.length > 1 && <span style={{ fontSize: 10, fontWeight: 700, color: C.dimmer, letterSpacing: ".05em" }}>C{g.courtNo + 1}</span>}
                    <span style={{ fontSize: 13, fontWeight: 800, color: on ? C.accent : C.dim }}>{on ? "✓" : "→"}</span>
                  </motion.button>
                );
              })}
            </div>
          </div>
        )}

        {s.lastLogged && !s.logPlanGameId && (
          <button onClick={rematch} className={press} style={{ width: "100%", marginBottom: 12, background: "rgba(203,251,79,.08)", border: "1px solid rgba(203,251,79,.25)", borderRadius: 12, color: C.accent, fontSize: 13, fontWeight: 700, padding: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}><RematchIcon />Rematch · {[...s.lastLogged.teamA, ...s.lastLogged.teamB].map((id) => initial(A(id).name)).join(" ")}</button>
        )}

        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <TeamPanel team={s.teamA} label="TEAM A" accent />
          <TeamPanel team={s.teamB} label="TEAM B" accent={false} />
        </div>

        <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 8 }}>Tap to assign · A → B → off</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: away.length ? 10 : 18 }}>
          {here.map((p) => chip(p, false))}
          {!away.length && hidden > 0 && moreChip(hidden)}
        </div>
        {away.length > 0 && (
          <>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.dimmer, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 7 }}>Not here tonight</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 18 }}>
              {away.map((p) => chip(p, true))}
              {hidden > 0 && moreChip(hidden)}
            </div>
          </>
        )}

        <div style={{ background: C.panel, border: "1px solid rgba(255,255,255,.06)", borderRadius: 18, padding: 16 }}>
          <div style={{ textAlign: "center", fontSize: 11, color: C.dim, fontWeight: 600, marginBottom: 12 }}>
            {winner === null ? `TAP THE WINNER · TO ${pointsTo}` : "SLIDE THE LOSER’S SCORE · WIN BY 2"}
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "center", gap: 10 }}>
            {col("A")}
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 22, color: "#3A4046", fontWeight: 700, marginTop: 26 }}>:</div>
            {col("B")}
          </div>
          <AnimatePresence initial={false}>
            {loser && (
              <motion.div
                initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                transition={SOFT} style={{ overflow: "hidden" }}
              >
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.06)" }}>
                  <div style={{ textAlign: "center", fontSize: 10, fontWeight: 700, color: C.dimmer, letterSpacing: ".06em", marginBottom: 4 }}>TEAM {loser} SCORED</div>
                  <ScoreRail value={loser === "A" ? s.scoreA : s.scoreB} onChange={(v) => setLoser(loser, v)} tint={C.fg} />
                  {/* Sliding past 19 is how you enter a game that went beyond 21 — the winner
                      follows on its own, so say so rather than leaving people hunting for it. */}
                  <div style={{ textAlign: "center", fontSize: 11, color: C.dim, marginTop: 6, lineHeight: 1.4 }}>
                    {Math.max(s.scoreA, s.scoreB) > pointsTo
                      ? <>Deuce — <span style={{ color: C.accent, fontWeight: 700 }}>{Math.max(s.scoreA, s.scoreB)}–{Math.min(s.scoreA, s.scoreB)}</span> to team {winner}</>
                      : `Went past ${pointsTo}? Keep sliding — the winner follows.`}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <motion.button onClick={submitMatch} whileTap={{ scale: ready ? 0.97 : 1 }} animate={{ backgroundColor: ready ? C.accent : C.raised, color: ready ? C.ink : C.dimmer }} transition={SPRING} disabled={!ready} style={{ width: "100%", marginTop: 16, height: 54, borderRadius: 15, border: "none", fontSize: 16, fontWeight: 800, cursor: ready ? "pointer" : "default" }}>Submit match</motion.button>
        {!ready && <div style={{ textAlign: "center", fontSize: 12, color: C.dim, marginTop: 10 }}>{s.teamA.length < 2 || s.teamB.length < 2 ? "Pick 2 players per team" : "Tap the winning team"}</div>}
      </div>
    );
  }

  function TeamPanel({ team, label, accent }: { team: string[]; label: string; accent: boolean }) {
    return (
      <div style={{ flex: 1, background: C.surface, border: `1px solid ${accent ? "rgba(203,251,79,.25)" : "rgba(255,255,255,.1)"}`, borderRadius: 16, padding: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".06em", color: accent ? C.accent : C.silver, textAlign: "center", marginBottom: 10 }}>{label}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 104 }}>
          {[0, 1].map((i) => {
            const id = team[i];
            return (
              <motion.div key={i} animate={{ backgroundColor: id ? "#1B1F23" : "rgba(0,0,0,0)" }} transition={SPRING} style={{ display: "flex", alignItems: "center", gap: 8, height: 44, borderRadius: 11, borderWidth: 1, borderStyle: id ? "solid" : "dashed", borderColor: "rgba(255,255,255,.12)", padding: "0 10px" }}>
                <AnimatePresence mode="wait" initial={false}>
                  {id ? (
                    <motion.div key={id} initial={{ opacity: 0, scale: 0.7, x: -6 }} animate={{ opacity: 1, scale: 1, x: 0 }} exit={{ opacity: 0, scale: 0.7 }} transition={SPRING} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Avatar name={A(id).name} color={A(id).color} size={28} /><span style={{ fontSize: 13, fontWeight: 600 }}>{A(id).name}</span>
                    </motion.div>
                  ) : (
                    <motion.span key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ fontSize: 12, color: "#4A5056" }}>Empty slot</motion.span>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderProfile() {
    const p = A(s.viewId!);
    if (!p) return null;
    return (
      <ProfileScreen
        p={p}
        resolve={A}
        isOwn={p.id === me}
        now={data.now}
        onOpenPlayer={openProfile}
        onOpenH2H={(otherId) => setS({ h2h: { a: p.id, b: otherId } })}
        onOpenMatch={openMatchById}
        onOpenDay={(cell: GridCell) => setS({ heatDay: { day: cell.day, matchIds: cell.matchIds } })}
        onExplain={() => setS({ explainId: p.id })}
        onSignOut={doSignOut}
        period={period}
        final={pastSeason}
      />
    );
  }

  function renderMe() {
    const mp = me ? A(me) : null;
    const myScore = mp ? `${mp.rating} rating` : "";
    return (
      <div style={{ padding: "14px 16px 0" }}>
        {mp && (
          <button onClick={() => openProfile(me!)} className={press} style={{ width: "100%", display: "flex", alignItems: "center", gap: 14, background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 16, padding: 15, cursor: "pointer", textAlign: "left", marginBottom: 18 }}>
            <Avatar name={mp.name} color={mp.color} size={52} />
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 18, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{mp.name}</div><div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 7, rowGap: 5, marginTop: 3 }}><span style={{ fontSize: 12.5, color: C.accent, fontFamily: "var(--font-mono)" }}>{!mp.games ? (scope === "all" ? "Unranked" : `No games ${period}`) : mp.provisional ? `${rankLine(mp, pastSeason)} · ${myScore}` : mp.rank ? `#${mp.rank} · ${myScore}` : `Resting · ${myScore}`}</span>{mp.games > 0 && <TierChip rating={mp.rating} provisional={mp.provisional} />}</div></div>
            <Chevron dir="right" color={C.dim} />
          </button>
        )}

        {amAdmin && !adminOn && (
          <>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 9 }}>Admin</div>
            {renderAdminUnlock("Fixing scores, deleting games and managing players need the admin code. It stays unlocked on this phone for 12 hours.")}
          </>
        )}
        {adminOn && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "rgba(203,251,79,.06)", border: "1px solid rgba(203,251,79,.22)", borderRadius: 12, padding: "9px 12px", marginBottom: 18 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: C.fg }}>
                Admin unlocked until {new Date(data.adminUntil!).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: LEAGUE_TZ })}
              </span>
              <button onClick={doLockAdmin} className={press} style={{ fontSize: 12, fontWeight: 700, color: C.muted, background: "none", border: "1px solid rgba(255,255,255,.12)", borderRadius: 8, padding: "5px 11px", cursor: "pointer" }}>Lock</button>
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 9 }}>Manage players</div>
            <div style={{ background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 16, padding: 12, marginBottom: 18 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: roster.length ? 12 : 0 }}>
                <input
                  value={s.newPlayerName}
                  onChange={(e) => setS({ newPlayerName: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") doAddPlayer(); }}
                  placeholder="Add a player…"
                  style={{ flex: 1, background: C.bg, border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, color: C.fg, fontSize: 14, padding: "10px 12px", outline: "none" }}
                />
                <button onClick={doAddPlayer} disabled={s.savingPlayer} className={press} style={{ borderRadius: 10, border: "none", background: C.accent, color: C.ink, fontSize: 14, fontWeight: 800, padding: "0 16px", cursor: s.savingPlayer ? "default" : "pointer", opacity: s.savingPlayer ? 0.6 : 1 }}>{s.savingPlayer ? "Adding…" : "Add"}</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {roster.map((p) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 2px" }}>
                    <Avatar name={p.name} color={p.color} size={26} />
                    {s.editPlayerId === p.id ? (
                      <>
                        <input
                          autoFocus
                          value={s.editPlayerName}
                          onChange={(e) => setS({ editPlayerName: e.target.value })}
                          onKeyDown={(e) => { if (e.key === "Enter") doRenamePlayer(); if (e.key === "Escape") cancelRename(); }}
                          style={{ flex: 1, minWidth: 0, background: C.bg, border: "1px solid rgba(255,255,255,.1)", borderRadius: 8, color: C.fg, fontSize: 14, padding: "6px 9px", outline: "none" }}
                        />
                        <button onClick={doRenamePlayer} disabled={s.savingPlayer} className={press} style={{ fontSize: 12, fontWeight: 800, color: C.ink, background: C.accent, border: "none", borderRadius: 8, padding: "6px 11px", cursor: s.savingPlayer ? "default" : "pointer", opacity: s.savingPlayer ? 0.6 : 1 }}>{s.savingPlayer ? "Saving…" : "Save"}</button>
                        <button onClick={cancelRename} className={press} style={{ fontSize: 12, fontWeight: 700, color: C.dim, background: "none", border: "none", padding: "6px 4px", cursor: "pointer" }}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{p.name}{p.id === me && <span style={{ fontSize: 11, color: C.dim, fontWeight: 500, marginLeft: 6 }}>you</span>}</span>
                        <button onClick={() => startRename(p.id, p.name)} className={press} aria-label="Edit name" style={{ display: "flex", alignItems: "center", color: C.muted, background: "none", border: "1px solid rgba(255,255,255,.1)", borderRadius: 8, padding: "5px 8px", cursor: "pointer" }}><EditIcon /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: C.dimmer, marginTop: 10, lineHeight: 1.4 }}>New players use the shared sign-in code. Tap the pencil to fix a name.</div>
            </div>
          </>
        )}

        <button onClick={doSignOut} className={press} style={{ width: "100%", height: 48, borderRadius: 14, background: "none", border: "1px solid rgba(255,107,107,.3)", color: C.loss, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Sign out</button>
      </div>
    );
  }

  /** For an admin player whose session isn't unlocked: the one way admin powers switch on. */
  function renderAdminUnlock(note: string) {
    return (
      <div style={{ background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, padding: 12, marginBottom: 18 }}>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.45, marginBottom: 10 }}>{note}</div>
        <form onSubmit={(e) => { e.preventDefault(); doUnlockAdmin(); }} style={{ display: "flex", gap: 8 }}>
          <input
            type="password"
            value={s.adminCode}
            onChange={(e) => setS({ adminCode: e.target.value })}
            placeholder="Admin code"
            autoComplete="off"
            aria-label="Admin code"
            style={{ flex: 1, minWidth: 0, background: C.bg, border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, color: C.fg, fontSize: 14, padding: "10px 12px", outline: "none" }}
          />
          <button type="submit" disabled={s.adminBusy || !s.adminCode} className={press} style={{ borderRadius: 10, border: "none", background: s.adminCode ? C.accent : C.raised, color: s.adminCode ? C.ink : C.dimmer, fontSize: 14, fontWeight: 800, padding: "0 16px", cursor: s.adminCode ? "pointer" : "default", opacity: s.adminBusy ? 0.6 : 1 }}>
            {s.adminBusy ? "Checking…" : "Unlock"}
          </button>
        </form>
      </div>
    );
  }

  function renderNav() {
    const onLog = s.screen === "log";
    const meActive = s.screen === "me" || s.screen === "profile";
    return (
      <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 480, height: "calc(84px + env(safe-area-inset-bottom))", background: "rgba(12,14,16,.92)", backdropFilter: "blur(12px)", borderTop: "1px solid rgba(255,255,255,.07)", display: "flex", alignItems: "flex-start", justifyContent: "space-around", padding: "10px 6px env(safe-area-inset-bottom)", zIndex: 40 }}>
        <NavBtn label="Ladder" active={s.screen === "ladder"} onClick={() => nav("ladder")}><LadderIcon /></NavBtn>
        <NavBtn label="Matchmaker" active={s.screen === "matchmaker"} onClick={() => nav("matchmaker")}><MmIcon /></NavBtn>
        <button onClick={() => nav("log")} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 58, marginTop: -14 }}>
          <motion.div whileTap={{ scale: 0.88 }} animate={{ scale: onLog ? 1.08 : 1, rotate: onLog ? 90 : 0 }} transition={BOUNCE} style={{ width: 52, height: 52, borderRadius: "50%", background: C.accent, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: onLog ? "0 8px 26px rgba(203,251,79,.5)" : "0 6px 20px rgba(203,251,79,.3)" }}><PlusIcon /></motion.div>
          <span style={{ fontSize: 10, fontWeight: 700, color: onLog ? C.accent : C.muted }}>Log</span>
        </button>
        <NavBtn label="Stats" active={s.screen === "stats"} onClick={() => nav("stats")}><StatsIcon /></NavBtn>
        <NavBtn label="Me" active={meActive} onClick={() => nav("me")}><UserIcon /></NavBtn>
      </div>
    );
  }
}
