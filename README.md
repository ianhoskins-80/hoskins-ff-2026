# Fantasy Dashboard

A live scoreboard for fantasy football leagues. A scheduled backend job polls ESPN's Fantasy Football API and caches the results; a static frontend renders matchup cards and combined standings from that cache.

**Live site:** https://hoskins-ff-2026.web.app

The page auto-refreshes on load and every 5 minutes thereafter, aligned to the backend's refresh schedule (:00, :05, :10, ...).

> Setting this up from scratch (new GCP/Firebase projects)? See [SETUP.md](SETUP.md).

## Architecture

Two separate Google Cloud / Firebase projects are involved by design — the frontend calls the backend by full URL, so they don't need to share a project.

| Project | Purpose |
|---|---|
| `fantasy2026` | Google Cloud project — runs the Cloud Functions and Firestore cache |
| `hoskins-ff-2026` | Firebase project — hosts the static frontend |

## Project Structure

```
fantasy-dashboard-function/   Backend: Cloud Functions
  index.js                    Both functions (refreshLeagues, getDashboard)
  package.json                 Dependencies (Node 22 runtime)

fantasy-dashboard-site/       Frontend: Firebase Hosting
  index.html                   The dashboard (single-page, no build step)
  firebase.json                 Hosting config
  .firebaserc                   Firebase project alias
```

## Backend

### Cloud Functions (region: `us-central1`)

**`refreshLeagues`** — scheduled, not public
- Fetches ESPN data for each league in the `LEAGUES` config array in `index.js`
- Writes results to Firestore (`fantasy-dashboard/latest`)
- Triggered by Cloud Scheduler; not meant to be called directly

**`getDashboard`** — public
- Returns the cached Firestore document (`leagues`, `updatedAt`) plus `standingsHistory` (every completed week's snapshot, see Firestore below) to the frontend
- URL: `https://us-central1-fantasy2026.cloudfunctions.net/getDashboard`
- Falls back to a live ESPN fetch if no cache exists yet (first-run only)

### Cloud Scheduler

| | |
|---|---|
| Job name | `refresh-fantasy-leagues` |
| Schedule | `*/5 * * * *` (every 5 minutes, on the clock) |
| Location | `us-central1` |
| Auth | Invokes `refreshLeagues` via the `dashboard-scheduler` service account |

Manual trigger (useful after a redeploy, so you don't wait for the next mark):
```bash
gcloud scheduler jobs run refresh-fantasy-leagues --location=us-central1 --project=fantasy2026
```

### Firestore

**`fantasy-dashboard/latest`** — single document, overwritten every 5 minutes:
- `leagues` — array of `{ color, data }`, where `data` is the **full, untrimmed** ESPN league response
- `updatedAt` — ISO timestamp

The full ESPN response is stored (not a trimmed subset) because the frontend's "Currently Playing" / "Yet to Play" metrics depend on per-player roster data only present there. Don't trim this payload without checking whether the frontend still needs those fields.

**`standings-history/{week}`** — one doc per completed NFL week, written by `refreshLeagues`:
- `week` — the week number (matches ESPN's `matchupPeriodId`)
- `snapshotAt` — ISO timestamp of the write
- `standings` — combined cross-league rank for that week: `[{ teamId, teamName, leagueColor, pointsFor, rank }]`

Written by comparing ESPN's `status.currentMatchupPeriod` on each fetch, not a calendar day — once it advances past `N`, week `N`'s season-to-date totals are final, so `refreshLeagues` (over)writes `standings-history/N` on every run until the period advances again. This makes it self-healing (a missed 5-min cycle doesn't lose a week) without needing to track "have I already snapshotted this week" as separate state. See `computeCombinedStandings()` / `snapshotStandingsIfWeekComplete()` in `index.js` — the ranking logic there is intentionally kept in sync with the frontend's Combined Standings sort.

## Frontend

The frontend is a single static `index.html` with no build step. It:
- Fetches `DASHBOARD_API_URL` (the `getDashboard` endpoint above) on page load
- Re-fetches every 5 minutes while the tab stays open, aligned to the backend's refresh cycle
- Renders themed matchup cards per league and a combined, points-sorted standings table (rank, team, record, win%, total points, playoff odds)
- Highlights the team currently leading a live matchup, and the winning side of a completed week, with a subtle background tint (matching the league's red/blue) behind its name and score
- A small helmet icon next to each team name links out to that team's ESPN page; clicking the team name itself opens a modal (see below)
- Every clickable element has a hover tooltip describing what it opens

All of the popups below share one modal component (`#modalBackdrop` / `#modalDialog` in `index.html`) — only the body content differs. It's dismissible via the ✕ button, a backdrop click, or Escape, and renders as a full-width bottom sheet on narrow viewports.

### Roster lightbox

Clicking a team name in a matchup card opens a modal listing that team's roster for the current week — position, player, NFL team, projected points, and actual points, grouped into Starters / Bench / IR. A player flagged by ESPN as questionable, out, etc. gets a small abbreviated badge next to their name (Q, D, O, IR, DTD, SUSP, P, INACT).

Player position, roster slot, and NFL team are resolved from ESPN's undocumented-but-stable numeric ID tables (`POSITION_NAMES`, `SLOT_NAMES`, `PRO_TEAM_ABBR` near the top of the `<script>` block). If ESPN adds a new slot type, the lookup falls back to `—` rather than erroring — extend the relevant map if a new ID shows up.

### Score history

Clicking a team name in the Combined Standings table opens that team's season history — one row per completed week (opponent, score for/against, W/L/T), sourced by walking `league.data.schedule` for every `matchupPeriodId` before the current week (there's no separate "history" endpoint; the schedule already holds every week). The "For" score is tinted in the league's color on weeks that team won, same treatment as the matchup-card winning highlight.

### Matchup comparison

Clicking the small "vs" glyph between the two teams on a matchup card, or a week number inside the score-history modal, opens a side-by-side comparison: both teams' full rosters (same Pos/Player/Team/Proj/Actual table as the roster lightbox) for that specific week, with the winning team's header tinted.

For a past week, this shows a caveat note: `rosterForCurrentScoringPeriod` on a schedule entry reflects each team's *current* lineup, not necessarily who they actually started that historical week if they've made roster moves since. Each player's projected/actual points are still correct for that week regardless (stats are keyed by `scoringPeriodId`) — only the "who was starting" grouping could be stale. This isn't shown for the current week, where the lineup is accurate by definition.

### Points by position

Below "This Week's Matchups," a matrix table: one row per team (combined across leagues, sorted alphabetically by team name), one column per real position (QB/RB/WR/TE/D-ST/K/HC — a FLEX-WR counts under WR, not a separate FLEX column). Each cell is that position's summed **actual** points for the current week (falls back to summed projected, shown in italics, before kickoff). Built entirely from the same per-game roster data already used by the roster lightbox — no backend changes.

- **Multi-player cells:** a team starting 2 RBs sums to one RB total; hovering a cell (native `title` tooltip) or clicking it (opens the shared modal) shows the per-player breakdown behind that number.
- **League filter:** pill buttons ("All Leagues" / each league by name) above the table filter which rows show. Only appears once more than one league has data — with a single league it'd just be a redundant "All" vs. itself, so it self-activates once League 2 joins rather than needing a code change.

### Standings trend chart

Below the standings table, a hand-rolled inline SVG line chart (no charting library — this project has no external JS dependencies) plots each team's combined rank across the season, built from `payload.standingsHistory`: X-axis is week (labeled "Week"), Y-axis is rank (labeled "Rank (1 = best)", inverted so rank 1 is at the top), one line per team.

- **Color:** each league gets a base hue (red/blue), with lightness spread across that league's teams (`teamLineColor()`), so the palette scales automatically as teams/leagues are added instead of a hardcoded N-color list.
- **Filtering:** multi-select (`selectedChartTeamIds`, a `Set`) — clicking a legend chip, a line, or a specific point toggles that team into or out of the shown set. With nothing selected, all teams show (the default). Once one or more are selected, every *other* team's line and points are fully hidden (not just dimmed), so comparing a handful of specific teams out of 16+ stays legible. "Show all" clears the set. This is click/tap-driven rather than hover-only, since hover doesn't exist on touch.
- **Per-point detail:** each point carries a native SVG `<title>` (team, week, rank, points) shown on hover — no custom tooltip UI needed.
- **Empty state:** shows a placeholder message until at least one week has completed.

> **Team identity across leagues:** ESPN's numeric team `id` is only unique *within* one league — two independently-created leagues can (and likely will) both have a team with id `1`. Both the chart and the position matrix key teams by `${leagueColor}:${teamId}`, not the raw id, so teams from different leagues never collide into one line/row. Keep this in mind if you add another feature that indexes teams by id.

### Matchup card metrics

| Metric | Status |
|---|---|
| Projected | Direct from ESPN's `totalProjectedPoints`. Fully working. |
| Currently Playing / Yet to Play | Computed client-side from each team's starting lineup (`rosterForCurrentScoringPeriod.entries`, excluding bench/IR). A starter counts as "playing" if ESPN has posted an actual (non-projected) stats entry (`statSourceId === 0`). This is an inferred proxy, not an explicit ESPN field — worth re-validating against real in-season data. |
| Mins Left | **Not implemented.** Hidden from the UI for now (the metric row is still in the DOM, just marked `hidden`, so it's a one-line change to bring back). ESPN's live game-clock data isn't currently pulled or parsed; needs either the `mLiveScoring` view or a separate live-scores data source. |

### Versioning

The dashboard displays its build number in a footer at the bottom of the page ("Build vX.Y"), sourced from the `BUILD_VERSION` constant near the top of the `<script>` block in `index.html`.

**Scheme:** `vMAJOR.MINOR`
- Bump **MINOR** for routine updates — bug fixes, small UI tweaks, metric changes
- Bump **MAJOR** for significant changes — new features, redesigns, or backend contract changes that affect the frontend

Bump `BUILD_VERSION` on every deploy that changes `index.html`, before running `firebase deploy`, so the footer always reflects what's actually live.

## League Configuration

Currently active:
- **League 1 (red):** "Sacking John Since Draft Day" — ID `566236785` — public

Pending:
- **League 2 (blue):** ID not yet available — manager hasn't made it public yet

### Adding a league

1. Confirm the league is public in ESPN's settings — test in an incognito browser tab against:
   ```
   https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/LEAGUE_ID?view=mTeam&view=mStandings&view=mSettings
   ```
   It should return JSON with no login prompt. ESPN's league JSON has an `isPublic` field in `settings` that must be `true` for the Cloud Function to read it unauthenticated.

2. Edit the `LEAGUES` array in `fantasy-dashboard-function/index.js`:
   ```js
   const LEAGUES = [
     { id: '566236785', color: 'red' },
     { id: 'YOUR_LEAGUE_ID', color: 'blue' },
   ];
   ```

3. Redeploy both functions (see [Deployment](#deployment) below).

4. Trigger a manual refresh so it doesn't wait for the next 5-minute mark:
   ```bash
   gcloud scheduler jobs run refresh-fantasy-leagues --location=us-central1 --project=fantasy2026
   ```

No frontend changes are needed — it automatically renders whatever leagues come back from the API.

## Deployment

### Frontend
```bash
cd fantasy-dashboard-site
firebase deploy --only hosting
```

### Backend
```bash
cd fantasy-dashboard-function
gcloud functions deploy refreshLeagues --gen2 --runtime=nodejs22 --region=us-central1 --source=. --entry-point=refreshLeagues --trigger-http --no-allow-unauthenticated --project=fantasy2026
gcloud functions deploy getDashboard --gen2 --runtime=nodejs22 --region=us-central1 --source=. --entry-point=getDashboard --trigger-http --allow-unauthenticated --project=fantasy2026
```

## Verifying things are working

Check cached data directly:
```bash
curl "https://us-central1-fantasy2026.cloudfunctions.net/getDashboard"
```
Look at `updatedAt` — it should be within the last 5 minutes.

Check IAM ownership on the backend project (if permission issues come up):
```bash
gcloud projects get-iam-policy fantasy2026 --flatten="bindings[].members" --filter="bindings.members:YOUR_EMAIL" --format="table(bindings.role)"
```

## Notes

- Both Cloud Functions run on **Node 22** (Node 20 is EOL Oct 30, 2026).
- Both leagues must be manually set to public in ESPN's league settings before their ID can be added to `LEAGUES`.

## License

[MIT](LICENSE)
