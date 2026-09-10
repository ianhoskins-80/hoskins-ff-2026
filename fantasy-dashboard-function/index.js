const functions = require('@google-cloud/functions-framework');
const { Firestore } = require('@google-cloud/firestore');

const firestore = new Firestore();

// ---------------------------------------------------------------------
// LEAGUE CONFIG
// Add a { id, color } entry per league, then redeploy both functions
// (see README.md's "Adding a league" and "Deployment" sections).
// ---------------------------------------------------------------------
const SEASON = 2026;
const LEAGUES = [
  { id: '566236785', color: 'red' },
  { id: '101181062', color: 'blue' },
];
// ---------------------------------------------------------------------

const ESPN_VIEWS = ['mTeam', 'mStandings', 'mSettings', 'mMatchupScore', 'mScoreboard'];

function buildUrl(leagueId) {
  const viewParams = ESPN_VIEWS.map(v => `view=${v}`).join('&');
  return `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${leagueId}?${viewParams}`;
}

async function fetchLeague(leagueId) {
  const res = await fetch(buildUrl(leagueId));
  if (!res.ok) {
    throw new Error(`ESPN fetch failed for league ${leagueId}: HTTP ${res.status}`);
  }
  return res.json();
}

// A standard NFL game is 4 15-min quarters; ESPN's per-game `clock` is
// seconds remaining in the *current* period. "Time left in the game" for
// a period still in regulation is however many full periods remain after
// this one, plus the current period's own clock. In overtime (period > 4)
// there's nothing scheduled after it, so it's just the current clock.
const REGULATION_PERIODS = 4;
const SECONDS_PER_PERIOD = 15 * 60;
function secondsRemainingInGame(period, clockSeconds) {
  if (!period || period < 1) return null;
  if (period > REGULATION_PERIODS) return clockSeconds;
  return (REGULATION_PERIODS - period) * SECONDS_PER_PERIOD + clockSeconds;
}

// Public, unauthenticated ESPN scoreboard -- a *different* ESPN API than
// the fantasy one above (site.api.espn.com, not lm-api-reads.fantasy).
// This is what actually knows whether an NFL game is live right now
// (status.type.state: 'pre' | 'in' | 'post'), how much game clock is
// left, and when it kicks off (event.date); the fantasy API's own
// per-player stats only tell you whether ESPN has posted *any* stat for
// a player this week, which doesn't distinguish a game still in progress
// from one that already ended, and carries no schedule/clock data at
// all. Returns one status per NFL team abbreviation (both sides of every
// game get the same status), used by Live Scoring, the matchup-card
// metrics (Currently Playing / Yet to Play / Mins Left), and the roster
// modal's per-player game time, so there's a single scoreboard fetch per
// refresh cycle, not one per feature.
async function fetchNflGameStatus(week) {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${week}&year=${SEASON}&seasontype=2`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`ESPN scoreboard fetch failed: HTTP ${res.status}`);
    }
    const data = await res.json();
    const statusByTeam = {};
    (data.events || []).forEach(event => {
      const state = event.status?.type?.state; // 'pre' | 'in' | 'post'
      const period = event.status?.period ?? 0;
      const clockSeconds = event.status?.clock ?? 0;
      const secondsRemaining = state === 'in' ? secondsRemainingInGame(period, clockSeconds) : null;
      const date = event.date || null; // ISO kickoff time -- stays put once the game starts/ends, unlike state/clock
      const competitors = event.competitions?.[0]?.competitors || [];
      competitors.forEach(c => {
        if (c.team?.abbreviation) statusByTeam[c.team.abbreviation] = { state, secondsRemaining, date };
      });
    });
    return statusByTeam;
  } catch (err) {
    // Non-fatal -- Live Scoring and the matchup-card live metrics just
    // fall back to "unknown" this cycle rather than breaking the main
    // dashboard refresh.
    console.error('Failed to fetch NFL scoreboard:', err.message);
    return {};
  }
}

// Mirrors the frontend's memberName() in index.html -- duplicated here, like
// POSITION_NAMES/SLOT_NAMES/PRO_TEAM_ABBR below, so the roster snapshot can
// be built server-side. Stores the raw ESPN casing; the frontend applies
// its own toTitleCase() at render time, so both live and snapshotted rows
// get standardized casing from one place.
function memberName(data, ownerId) {
  const m = (data.members || []).find(mm => mm.id === ownerId);
  return m ? (m.firstName + ' ' + m.lastName) : '';
}

// Mirrors the same lookup tables in the frontend (POSITION_NAMES/SLOT_NAMES/
// PRO_TEAM_ABBR in index.html) -- duplicated here, like computeCombinedStandings
// below, so the roster snapshot can be built server-side. Keep in sync.
const POSITION_NAMES = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
const SLOT_NAMES = { 0: 'QB', 2: 'RB', 3: 'RB/WR', 4: 'WR', 5: 'WR/TE', 6: 'TE', 7: 'OP', 16: 'D/ST', 17: 'K', 19: 'HC', 20: 'BE', 21: 'IR', 23: 'FLEX' };
const PRO_TEAM_ABBR = {
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN',
  8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA',
  16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT',
  24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
};

// Combined cross-league rank, sorted by season pointsFor -- same logic the
// frontend uses for the "Combined Standings" table, duplicated here so a
// weekly snapshot can be computed server-side. Keep these two in sync if
// the ranking rule ever changes.
function computeCombinedStandings(results) {
  const rows = [];
  results.forEach(({ color, data }) => {
    (data.teams || []).forEach(team => rows.push({ team, color }));
  });

  rows.sort((a, b) => {
    const apf = a.team.record?.overall?.pointsFor ?? 0;
    const bpf = b.team.record?.overall?.pointsFor ?? 0;
    if (bpf !== apf) return bpf - apf;
    // Mirrors the frontend's Combined Standings tiebreak -- see the comment
    // there for why playoff odds comes before ESPN's currentProjectedRank.
    const aPct = a.team.currentSimulationResults?.playoffPct ?? -1;
    const bPct = b.team.currentSimulationResults?.playoffPct ?? -1;
    if (bPct !== aPct) return bPct - aPct;
    return (a.team.currentProjectedRank ?? 99) - (b.team.currentProjectedRank ?? 99);
  });

  return rows.map((row, i) => ({
    teamId: row.team.id,
    teamName: row.team.name,
    leagueColor: row.color,
    pointsFor: row.team.record?.overall?.pointsFor ?? 0,
    rank: i + 1,
  }));
}

// Snapshots the combined standings for whichever week just completed, keyed
// by week number so re-running this on every 5-min refresh is naturally
// idempotent (it just overwrites that week's doc with the same, or a
// slightly more final, result -- a completed week's pointsFor don't change
// again once the next week has started). Detects "week complete" off
// ESPN's own currentMatchupPeriod rather than a calendar day, since that's
// the field this app already trusts everywhere else and it isn't thrown
// off by holiday schedules, bye weeks, or the Thursday-only postseason.
async function snapshotStandingsIfWeekComplete(results) {
  const currentWeek = results[0]?.data?.status?.currentMatchupPeriod ?? 1;
  const completedWeek = currentWeek - 1;
  if (completedWeek < 1) return;

  const standings = computeCombinedStandings(results);
  if (!standings.length) return;

  try {
    await firestore.collection('standings-history').doc(String(completedWeek)).set({
      week: completedWeek,
      snapshotAt: new Date().toISOString(),
      standings,
    });
  } catch (err) {
    // Non-fatal -- don't let a history-snapshot failure break the main
    // dashboard refresh.
    console.error('Failed to snapshot standings history:', err.message);
  }
}

// One-time seed of a "Week 0" (preseason) standings-history snapshot, so
// the frontend's rank-trend chart has a starting point instead of only
// beginning once Week 1 wraps up. Captured with the exact same ranking
// logic as every other week (computeCombinedStandings) -- before any
// game has posted a score, pointsFor ties at 0 for everyone and the
// order falls out of that function's own playoff-odds tiebreak, which is
// exactly the "preseason ranking" this is meant to capture.
//
// Written once and never touched again (guarded by both the doc-exists
// check and completedWeek < 1), unlike every other snapshot in this file
// which intentionally overwrites on every run -- once Week 1 actually
// wraps up, pointsFor stops being all-zero and doc 0 would no longer
// represent "preseason" if it kept refreshing.
async function seedPreseasonStandingsSnapshot(results) {
  const currentWeek = results[0]?.data?.status?.currentMatchupPeriod ?? 1;
  const completedWeek = currentWeek - 1;
  if (completedWeek >= 1) return;

  const ref = firestore.collection('standings-history').doc('0');
  const existing = await ref.get();
  if (existing.exists) return;

  const standings = computeCombinedStandings(results);
  if (!standings.length) return;

  try {
    await ref.set({ week: 0, snapshotAt: new Date().toISOString(), standings });
  } catch (err) {
    console.error('Failed to seed preseason standings snapshot:', err.message);
  }
}

// Snapshots every team's roster for the CURRENT week, every single run --
// unlike snapshotStandingsIfWeekComplete (which snapshots the week that
// just ended), this can't wait until a week is over to capture it.
// ESPN's `rosterForCurrentScoringPeriod` field is only populated for
// whichever week is presently active; every other week's schedule entry
// comes back with zero roster entries (confirmed by inspecting the live
// API response -- it's not "stale," it's empty). So the only reliable
// moment to capture a week's roster is *while it's still current*, and
// by the time the week ends and ESPN moves on, our last-captured
// snapshot (from minutes before rollover, with final stats already
// posted) is already safely in our own Firestore.
//
// Stores a trimmed per-player record (name/position/team/injury/points),
// not the raw ESPN blob, which carries a lot of nested stat-projection
// data this app doesn't need and would otherwise accumulate all season.
function buildRosterSnapshot(results) {
  const currentWeek = results[0]?.data?.status?.currentMatchupPeriod ?? 1;
  const teamsOut = {};

  results.forEach(({ color, data }) => {
    const teams = data.teams || [];
    const teamById = id => teams.find(t => t.id === id);
    const weekGames = (data.schedule || []).filter(g => g.matchupPeriodId === currentWeek);

    weekGames.forEach(g => {
      ['home', 'away'].forEach(side => {
        const sideData = g[side];
        if (!sideData) return;
        const team = teamById(sideData.teamId);
        const entries = (sideData.rosterForCurrentScoringPeriod?.entries || []).filter(Boolean);

        const players = entries.map(entry => {
          const player = entry.playerPoolEntry?.player || {};
          const stats = player.stats || [];
          const actualStat = stats.find(s => s.scoringPeriodId === currentWeek && s.statSourceId === 0);
          const projStat = stats.find(s => s.scoringPeriodId === currentWeek && s.statSourceId === 1);
          const slot = entry.lineupSlotId === 20 ? 'bench' : entry.lineupSlotId === 21 ? 'ir' : 'starter';

          return {
            name: player.fullName || 'Empty',
            position: POSITION_NAMES[player.defaultPositionId] || SLOT_NAMES[entry.lineupSlotId] || null,
            nflTeam: PRO_TEAM_ABBR[player.proTeamId] ?? null,
            injuryStatus: player.injuryStatus || null,
            slot,
            lineupSlotId: entry.lineupSlotId,
            actual: actualStat ? actualStat.appliedTotal : null,
            projected: projStat ? projStat.appliedTotal : null,
          };
        });

        teamsOut[`${color}:${sideData.teamId}`] = {
          teamName: team ? team.name : 'TBD',
          owner: team ? memberName(data, team.primaryOwner) : '',
          leagueColor: color,
          players,
        };
      });
    });
  });

  return { week: currentWeek, teams: teamsOut };
}

async function snapshotCurrentWeekRosters(results) {
  const { week, teams } = buildRosterSnapshot(results);
  if (!Object.keys(teams).length) return;

  try {
    await firestore.collection('roster-history').doc(String(week)).set({
      week,
      snapshotAt: new Date().toISOString(),
      teams,
    });
  } catch (err) {
    console.error('Failed to snapshot roster history:', err.message);
  }
}

// "Live Scoring" board -- every rostered STARTER (bench/IR excluded, same
// convention as everywhere else) whose real NFL team is currently mid-game
// (per fetchNflGameStatus, not the fantasy API's own weaker "has posted
// any stat this week" signal) AND who has actually scored (appliedTotal >
// 0) -- per explicit request, a currently-playing-but-scoreless starter
// doesn't show. Sorted highest points first.
async function buildLiveScoringBoard(results, gameStatus) {
  const currentWeek = results[0]?.data?.status?.currentMatchupPeriod ?? 1;
  const entries = [];

  results.forEach(({ color, data }) => {
    const teams = data.teams || [];
    const teamById = id => teams.find(t => t.id === id);
    const weekGames = (data.schedule || []).filter(g => g.matchupPeriodId === currentWeek);

    weekGames.forEach(g => {
      ['home', 'away'].forEach(side => {
        const sideData = g[side];
        if (!sideData) return;
        const team = teamById(sideData.teamId);
        const rosterEntries = (sideData.rosterForCurrentScoringPeriod?.entries || []).filter(Boolean);

        rosterEntries.forEach(entry => {
          if (entry.lineupSlotId === 20 || entry.lineupSlotId === 21) return; // bench / IR

          const player = entry.playerPoolEntry?.player || {};
          const nflTeam = PRO_TEAM_ABBR[player.proTeamId];
          if (!nflTeam || gameStatus[nflTeam]?.state !== 'in') return;

          const stats = player.stats || [];
          const actualStat = stats.find(s => s.scoringPeriodId === currentWeek && s.statSourceId === 0);
          const points = actualStat ? actualStat.appliedTotal : 0;
          if (!(points > 0)) return;

          entries.push({
            playerId: player.id,
            playerName: player.fullName || 'Unknown',
            position: POSITION_NAMES[player.defaultPositionId] || SLOT_NAMES[entry.lineupSlotId] || null,
            nflTeam,
            teamId: sideData.teamId,
            teamName: team ? team.name : 'TBD',
            leagueColor: color,
            points,
          });
        });
      });
    });
  });

  entries.sort((a, b) => b.points - a.points);

  // "Trend" -- compare each player's points to the *previous* refresh's
  // snapshot, stored in Firestore since a Cloud Function doesn't retain
  // memory between invocations. Tied to the backend's own 5-min cadence,
  // not "since this browser tab last polled", so the flag is correct no
  // matter when a viewer's page happens to load. 'up' covers the normal
  // case (scored more); 'down' is rare but real -- ESPN does occasionally
  // revise appliedTotal downward on a stat correction/recategorization
  // within the same live window, and that's worth surfacing distinctly
  // rather than silently, same as an increase is.
  const prevRef = firestore.collection('fantasy-dashboard').doc('live-scoring-prev');
  let previousPoints = {};
  try {
    const prevDoc = await prevRef.get();
    previousPoints = prevDoc.exists ? (prevDoc.data().points || {}) : {};
  } catch (err) {
    console.error('Failed to read previous live-scoring snapshot:', err.message);
  }

  const nextPoints = {};
  entries.forEach(e => {
    const prevValue = previousPoints[e.playerId] ?? 0;
    e.trend = e.points > prevValue ? 'up' : e.points < prevValue ? 'down' : null;
    nextPoints[e.playerId] = e.points;
  });

  try {
    await prevRef.set({ points: nextPoints, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Failed to write live-scoring snapshot:', err.message);
  }

  return entries;
}

// ESPN's own `totalPoints` on a schedule matchup side stays frozen at 0
// for the CURRENT week until that week is officially finalized (stat
// corrections locked, usually the following Tuesday) -- it is NOT a live
// running score, even though `mMatchupScore` is in ESPN_VIEWS. The real
// live number is sitting right next to it though: `pointsByScoringPeriod`
// is keyed by week and DOES update live (confirmed against the roster's
// own actual stats, which match it exactly). Patches `totalPoints` for
// this week's (and only this week's) schedule matchups with that value --
// every consumer of schedule[].home/away.totalPoints (matchup cards, the
// Week Total line, the score-history chart, the roster-comparison modal)
// reads this same field, so fixing it here fixes all of them at once.
// Past weeks are left alone: ESPN's own post-finalization totalPoints for
// a completed week is authoritative, so only the still-in-progress
// current week is touched.
function patchLiveMatchupTotals(data) {
  const currentWeek = data.status?.currentMatchupPeriod ?? 1;
  const liveTotal = sideData => sideData?.pointsByScoringPeriod?.[currentWeek] ?? 0;
  (data.schedule || []).forEach(g => {
    if (g.matchupPeriodId !== currentWeek) return;
    if (g.home) g.home.totalPoints = liveTotal(g.home);
    if (g.away) g.away.totalPoints = liveTotal(g.away);
  });
}

async function refreshAllLeagues() {
  const results = [];
  for (const league of LEAGUES) {
    try {
      const data = await fetchLeague(league.id);
      patchLiveMatchupTotals(data);
      results.push({ color: league.color, data });
    } catch (err) {
      console.error(`Failed to fetch league ${league.id}:`, err.message);
      // Keep going -- if one league fails, still cache whatever succeeded
      // so the dashboard doesn't go fully blank.
    }
  }

  const currentWeek = results[0]?.data?.status?.currentMatchupPeriod ?? 1;
  const gameStatus = await fetchNflGameStatus(currentWeek);
  const liveScoring = await buildLiveScoringBoard(results, gameStatus);

  await firestore.collection('fantasy-dashboard').doc('latest').set({
    leagues: results,
    liveScoring,
    gameStatus,
    updatedAt: new Date().toISOString(),
  });

  await snapshotStandingsIfWeekComplete(results);
  await seedPreseasonStandingsSnapshot(results);
  await snapshotCurrentWeekRosters(results);

  return { results, liveScoring, gameStatus };
}

// ---------------------------------------------------------------------
// FUNCTION 1: refreshLeagues
// Triggered on a schedule by Cloud Scheduler (every 5 min, on the
// 0/5/10/15... marks). Fetches ESPN, writes the result to Firestore.
// Not meant to be called directly by the browser.
// ---------------------------------------------------------------------
functions.http('refreshLeagues', async (req, res) => {
  try {
    const { results } = await refreshAllLeagues();
    res.status(200).json({ ok: true, leagueCount: results.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// FUNCTION 2: getDashboard
// Called by the frontend on page load / refresh. Returns the cached
// Firestore doc -- fast, and doesn't hit ESPN on every visitor.
// If there's no cache yet (first-ever run), it fetches live as a
// one-time fallback so the dashboard isn't empty.
// ---------------------------------------------------------------------
functions.http('getDashboard', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    const historySnapshot = await firestore.collection('standings-history').orderBy('week').get();
    const standingsHistory = historySnapshot.docs.map(d => d.data());

    const rosterHistorySnapshot = await firestore.collection('roster-history').orderBy('week').get();
    const rosterHistory = rosterHistorySnapshot.docs.map(d => d.data());

    const doc = await firestore.collection('fantasy-dashboard').doc('latest').get();
    if (!doc.exists) {
      const { results, liveScoring, gameStatus } = await refreshAllLeagues();
      res.status(200).json({ leagues: results, liveScoring, gameStatus, updatedAt: new Date().toISOString(), standingsHistory, rosterHistory });
      return;
    }
    res.status(200).json({ ...doc.data(), standingsHistory, rosterHistory });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// FUNCTION 3: heartbeat
// Called by the frontend every ~25s while a tab is open and visible, to
// power the "currently viewing" count shown on the page. Upserts that
// tab's presence doc (keyed by a random per-tab sessionId, no PII) with
// a fresh timestamp, then returns how many tabs have heartbeat within
// the last PRESENCE_TIMEOUT_MS -- a tab that stops heartbeating (closed,
// or backgrounded -- the frontend pauses heartbeats via the Page
// Visibility API) just ages out of that count on its own. No Firestore
// TTL policy needed: stale docs are opportunistically deleted inline on
// every call, so the collection can't grow unbounded even without one.
// ---------------------------------------------------------------------
const PRESENCE_TIMEOUT_MS = 90 * 1000;

functions.http('heartbeat', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  // Unlike getDashboard (a plain GET with no custom headers -- a CORS
  // "simple request" that never triggers a preflight), this is a POST
  // with a Content-Type header set, which does trigger one. The browser
  // sends an OPTIONS preflight asking to allow that header before it'll
  // let the real POST through, so it has to be explicitly echoed back
  // here -- without this, every real browser call fails CORS even
  // though a plain curl (no preflight) looks fine.
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    const sessionId = req.body && req.body.sessionId;
    // Strict allowlist (not just a length check) -- sessionId becomes a
    // Firestore document path segment below, and a value containing '/'
    // would resolve into a subcollection under presence/ instead of a
    // flat doc there. Matches what crypto.randomUUID() (or the frontend's
    // fallback generator) actually produces, so this never rejects a
    // legitimate caller.
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(sessionId)) {
      res.status(400).json({ error: 'Missing or invalid sessionId' });
      return;
    }

    const now = Date.now();
    await firestore.collection('presence').doc(sessionId).set({ lastSeen: now });

    const snapshot = await firestore.collection('presence').get();
    let activeCount = 0;
    const staleRefs = [];
    snapshot.forEach(doc => {
      const lastSeen = doc.data().lastSeen || 0;
      if (now - lastSeen <= PRESENCE_TIMEOUT_MS) {
        activeCount++;
      } else {
        staleRefs.push(doc.ref);
      }
    });

    if (staleRefs.length) {
      try {
        const batch = firestore.batch();
        staleRefs.forEach(ref => batch.delete(ref));
        await batch.commit();
      } catch (err) {
        // Non-fatal -- they'll just get swept up on a later call.
        console.error('Failed to clean up stale presence docs:', err.message);
      }
    }

    res.status(200).json({ activeCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
