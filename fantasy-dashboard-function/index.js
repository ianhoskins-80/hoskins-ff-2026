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
    const doc = await firestore.collection('fantasy-dashboard').doc('latest').get();
    if (!doc.exists) {
      const results = await refreshAllLeagues();
      res.status(200).json({ leagues: results, updatedAt: new Date().toISOString() });
      return;
    }
    res.status(200).json(doc.data());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
