# Fantasy Dashboard — Project Documentation

_Last updated: September 4, 2026_

## Live Site

**https://hoskins-ff-2026.web.app**

Auto-refreshes on page load and every 5 minutes thereafter (aligned to :00/:05/:10... marks).

---

## Project Structure

Two separate Google Cloud / Firebase projects are involved:

| Project | Purpose |
|---|---|
| `fantasy2026` | Google Cloud project — runs the two Cloud Functions and Firestore cache |
| `hoskins-ff-2026` | Firebase project — hosts the static dashboard frontend |

These are intentionally separate. The frontend calls the backend by full URL, so they don't need to share a project.

---

## Backend (`fantasy2026`)

### Cloud Functions (region: `us-central1`)

**`refreshLeagues`** — scheduled, not public
- Fetches ESPN data for each league in the `LEAGUES` config array (in `index.js`)
- Writes results to Firestore (`fantasy-dashboard/latest`)
- URL: `https://refreshleagues-y4ymhql2ka-uc.a.run.app`
- Triggered by Cloud Scheduler, not meant to be called directly

**`getDashboard`** — public
- Returns the cached Firestore doc to the frontend
- URL: `https://us-central1-fantasy2026.cloudfunctions.net/getDashboard`
- Falls back to a live ESPN fetch if no cache exists yet (first-run only)

### Cloud Scheduler

**Job name:** `refresh-fantasy-leagues`
**Schedule:** `*/5 * * * *` (every 5 minutes, on the clock: :00, :05, :10 ... :55)
**Location:** `us-central1`
**Auth:** invokes `refreshLeagues` via the `dashboard-scheduler` service account (`dashboard-scheduler@fantasy2026.iam.gserviceaccount.com`)

Manual trigger (useful after a redeploy, so you don't wait for the next mark):
```bash
gcloud scheduler jobs run refresh-fantasy-leagues --location=us-central1 --project=fantasy2026
```

### Firestore
- Single document: `fantasy-dashboard/latest`
- Contains `leagues` (array of `{ color, data }`) and `updatedAt` (ISO timestamp)

### Local backend files
Located wherever you keep the `fantasy-dashboard-function` folder on your machine:
- `index.js` — both Cloud Functions
- `package.json` — dependencies (Node 22 runtime)

The Cloud Function stores the **full, untrimmed ESPN response** for each league in Firestore — not just a slimmed-down subset. This was originally just the simplest implementation, but it turned out to matter: the frontend's "Currently Playing" / "Yet to Play" metrics (see Frontend section below) depend on per-player roster data that's only present in the full response. Don't trim this payload down without checking whether the frontend still needs those fields.

---

## Frontend (`hoskins-ff-2026`)

**Local folder:** `/Users/ianhoskins/hoskins-ff-2026/`
**Public directory:** `.` (index.html lives at the project root)
**Deployed file:** `index.html` (this is the dashboard — was originally named `dashboard.html` before being renamed for Firebase Hosting)

The frontend:
- Calls `DASHBOARD_API_URL` (hardcoded to the `getDashboard` URL above) on page load
- Re-fetches every 5 minutes while the tab stays open, aligned to the same clock marks as the backend scheduler
- Renders red/blue themed matchup cards and a combined, points-sorted standings table
- League name (in each matchup block header) and every team name link out to that team/league's real ESPN page, opening in a new tab
- Each team block shows: actual score (top right, next to team name), and a 2×2 metrics grid below — **Currently Playing**, **Yet to Play**, **Mins Left**, **Projected**

### Matchup card metrics — how they're computed

- **Projected** — direct from ESPN's `totalProjectedPoints` field. Fully working.
- **Currently Playing / Yet to Play** — computed client-side from each team's starting lineup (`rosterForCurrentScoringPeriod.entries`, excluding bench/IR slots). A starter counts as "playing" if ESPN has posted an *actual* (non-projected) stats entry for them (`statSourceId === 0`); otherwise they're "yet to play." This is a reasonable proxy for "has their real NFL game started," but it's inferred, not an explicit ESPN field — worth re-validating once real in-season data is available.
- **Mins Left** — **not implemented yet.** Always shows `—`. ESPN's live game-clock data isn't currently being pulled or parsed. This needs either the `mLiveScoring` view examined more closely, or a separate NFL live-scores data source. **Revisit once the season is live and there's real in-progress game data to test against** — this was intentionally deferred rather than guessing at a shape blind.

### Redeploying frontend changes
```bash
cd /Users/ianhoskins/hoskins-ff-2026
firebase deploy --only hosting
```

---

## League Configuration

Currently active:
- **League 1 (red):** "Sacking John Since Draft Day" — ID `566236785` — public ✅

Pending:
- **League 2 (blue):** ID not yet available — manager hasn't made it public yet

### Adding League 2 once its ID is available

1. Confirm the league is set to public in ESPN settings (test in an incognito browser tab against `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/LEAGUE_ID?view=mTeam&view=mStandings&view=mSettings` — should return JSON with no login prompt)

2. Edit `index.js` in the backend folder — uncomment and fill in:
   ```js
   const LEAGUES = [
     { id: '566236785', color: 'red' },
     { id: 'YOUR_LEAGUE_2_ID', color: 'blue' },
   ];
   ```

3. Redeploy both functions:
   ```bash
   cd fantasy-dashboard-function
   gcloud functions deploy refreshLeagues --gen2 --runtime=nodejs22 --region=us-central1 --source=. --entry-point=refreshLeagues --trigger-http --no-allow-unauthenticated --project=fantasy2026
   gcloud functions deploy getDashboard --gen2 --runtime=nodejs22 --region=us-central1 --source=. --entry-point=getDashboard --trigger-http --allow-unauthenticated --project=fantasy2026
   ```

4. Trigger a manual refresh so it doesn't wait for the next 5-minute mark:
   ```bash
   gcloud scheduler jobs run refresh-fantasy-leagues --location=us-central1 --project=fantasy2026
   ```

5. No frontend changes or redeploy needed — it automatically renders whatever leagues come back from the API.

---

## Verifying things are working

**Check cached data directly:**
```bash
curl "https://us-central1-fantasy2026.cloudfunctions.net/getDashboard"
```
Look at `updatedAt` — should be within the last 5 minutes.

**Check IAM ownership on the backend project (if permission issues ever come up):**
```bash
gcloud projects get-iam-policy fantasy2026 --flatten="bindings[].members" --filter="bindings.members:ian.hoskins@gmail.com" --format="table(bindings.role)"
```

---

## Notes / gotchas encountered during setup

- Node 20 was flagged for deprecation (EOL Oct 30, 2026) — project uses **Node 22** for both Cloud Functions.
- `firebase projects:addfirebase` on the original `fantasy2026` project failed with a 403 even with Owner role — resolved by creating hosting as its own fresh Firebase project (`hoskins-ff-2026`) instead of trying to attach Firebase to the existing GCP project.
- An initial stray Firebase project, `fantasy2026-dashboard`, was created accidentally during browser-based setup and has since been deleted.
- ESPN's league JSON has an `isPublic` field in `settings` — this must be `true` for the Cloud Function to read it without authentication. Both leagues need to be manually set to public in ESPN's league settings before their ID can be added here.
- Claude's in-chat file preview runs in a sandboxed environment with no outbound network access — previewing `index.html` there will always show "Failed to fetch" for the dashboard API call, even when everything is deployed and working correctly. To actually test changes, either open the file locally on the Mac (double-click it) or check the live Firebase Hosting URL — both have real internet access.
