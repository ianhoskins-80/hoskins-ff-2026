const functions = require('@google-cloud/functions-framework');
const { Firestore } = require('@google-cloud/firestore');

const firestore = new Firestore();

// ---------------------------------------------------------------------
// LEAGUE CONFIG
// This is the only thing you need to touch when the second league's
// ID becomes available. Uncomment the second entry, fill in the ID,
// then redeploy with the one-liner in DEPLOYMENT.md.
// ---------------------------------------------------------------------
const SEASON = 2026;
const LEAGUES = [
  { id: '566236785', color: 'red' },
  // { id: 'PUT_LEAGUE_2_ID_HERE', color: 'blue' },
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

    const doc = await firestore.collection('fantasy-dashboard').doc('latest').get();
    if (!doc.exists) {
      const results = await refreshAllLeagues();
      res.status(200).json({ leagues: results, updatedAt: new Date().toISOString(), standingsHistory });
      return;
    }
    res.status(200).json({ ...doc.data(), standingsHistory });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
