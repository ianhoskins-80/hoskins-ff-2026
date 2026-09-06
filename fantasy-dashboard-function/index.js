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

async function refreshAllLeagues() {
  const results = [];
  for (const league of LEAGUES) {
    try {
      const data = await fetchLeague(league.id);
      results.push({ color: league.color, data });
    } catch (err) {
      console.error(`Failed to fetch league ${league.id}:`, err.message);
      // Keep going -- if one league fails, still cache whatever succeeded
      // so the dashboard doesn't go fully blank.
    }
  }

  await firestore.collection('fantasy-dashboard').doc('latest').set({
    leagues: results,
    updatedAt: new Date().toISOString(),
  });

  await snapshotStandingsIfWeekComplete(results);
  await snapshotCurrentWeekRosters(results);

  return results;
}

// ---------------------------------------------------------------------
// FUNCTION 1: refreshLeagues
// Triggered on a schedule by Cloud Scheduler (every 5 min, on the
// 0/5/10/15... marks). Fetches ESPN, writes the result to Firestore.
// Not meant to be called directly by the browser.
// ---------------------------------------------------------------------
functions.http('refreshLeagues', async (req, res) => {
  try {
    const results = await refreshAllLeagues();
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
      const results = await refreshAllLeagues();
      res.status(200).json({ leagues: results, updatedAt: new Date().toISOString(), standingsHistory, rosterHistory });
      return;
    }
    res.status(200).json({ ...doc.data(), standingsHistory, rosterHistory });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
