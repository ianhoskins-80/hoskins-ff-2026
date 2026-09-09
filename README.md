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
  404.html                      Firebase's default not-found page (unmodified)
  firebase.json                 Hosting config
  .firebaserc                   Firebase project alias
```

## Backend

### Cloud Functions (region: `us-central1`)

**`refreshLeagues`** — scheduled, not public
- Fetches ESPN data for each league in the `LEAGUES` config array in `index.js`
- Also fetches the public NFL scoreboard (a *second*, separate ESPN API — see Live Scoring below) to know which NFL games are currently live
- Writes results to Firestore (`fantasy-dashboard/latest`)
- Triggered by Cloud Scheduler; not meant to be called directly

**`getDashboard`** — public
- Returns the cached Firestore document (`leagues`, `liveScoring`, `updatedAt`) plus `standingsHistory` and `rosterHistory` (every week's snapshot of each, see Firestore below) to the frontend
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
- `liveScoring` — the Live Scoring board, see below
- `gameStatus` — `{ [nflTeamAbbr]: { state: 'pre'|'in'|'post', secondsRemaining, date } }`, one entry per NFL team from the public scoreboard API (see Live Scoring, below) — also drives the matchup-card Currently Playing / Yet to Play / Mins Left metrics and the roster modal's per-player game time
- `updatedAt` — ISO timestamp

The full ESPN response is stored (not a trimmed subset) because the frontend's "Currently Playing" / "Yet to Play" metrics depend on per-player roster data only present there. Don't trim this payload without checking whether the frontend still needs those fields.

**`fantasy-dashboard/live-scoring-prev`** — internal-only, not read by the frontend: `{ points: { [playerId]: pointsAtLastRefresh }, updatedAt }`. Lets `buildLiveScoringBoard()` compare this cycle's points to the previous cycle's to flag a player as having just scored — see Live Scoring, below.

**`standings-history/{week}`** — one doc per completed NFL week, written by `refreshLeagues`:
- `week` — the week number (matches ESPN's `matchupPeriodId`)
- `snapshotAt` — ISO timestamp of the write
- `standings` — combined cross-league rank for that week: `[{ teamId, teamName, leagueColor, pointsFor, rank }]`

Written by comparing ESPN's `status.currentMatchupPeriod` on each fetch, not a calendar day — once it advances past `N`, week `N`'s season-to-date totals are final, so `refreshLeagues` (over)writes `standings-history/N` on every run until the period advances again. This makes it self-healing (a missed 5-min cycle doesn't lose a week) without needing to track "have I already snapshotted this week" as separate state. See `computeCombinedStandings()` / `snapshotStandingsIfWeekComplete()` in `index.js` — the ranking logic there is intentionally kept in sync with the frontend's Combined Standings sort.

**`standings-history/0`** — a special one-time "preseason" snapshot, seeded by `seedPreseasonStandingsSnapshot()` the first time `refreshLeagues` runs while Week 1 hasn't completed yet and doc `0` doesn't already exist. Same shape as every other week's doc, built with the same `computeCombinedStandings()` — since every team's `pointsFor` is 0 before any game posts a score, the order it captures is whatever that function's playoff-odds tiebreak produces. Unlike every other snapshot in this collection, it's written once and never overwritten again (guarded by both the doc-exists check and `completedWeek < 1`), since once real scores start posting it would stop meaning "preseason" if it kept refreshing.

**`roster-history/{week}`** — one doc per NFL week, written by `refreshLeagues` on **every** run (not just once a week ends):
- `week` — the week number
- `snapshotAt` — ISO timestamp of the write
- `teams` — `{ "leagueColor:teamId": { teamName, owner, leagueColor, players: [{ name, position, nflTeam, injuryStatus, slot, lineupSlotId, actual, projected }] } }`, one entry per team, `players` covering every roster slot (starters, bench, IR). `owner` is stored in ESPN's raw casing — the frontend's `toTitleCase()` standardizes it at render time (see Points by position, below). Snapshots written before this field existed simply lack it; the frontend treats a missing `owner` as an empty string rather than erroring.

This exists because ESPN's `rosterForCurrentScoringPeriod` field (used for the *current* week everywhere else in this app) is **only populated for whichever week is presently active** — every other week's schedule entry comes back with zero roster entries. It's not stale data, it's genuinely empty. That means a past week's roster can only ever come from a snapshot taken *while that week was still current* — waiting until a week ends to capture it (the way `standings-history` does) would be too late, since ESPN's own data for it may already be gone by then. So this writes the **current** week's roster on every single 5-min cycle, overwriting `roster-history/{currentWeek}` each time; whatever was captured in the last cycle before the period advances becomes that week's permanent record. `buildRosterSnapshot()` in `index.js` stores a trimmed per-player record rather than ESPN's full nested stat blob, since that accumulates significantly over a season.

**Limitation:** this can't backfill weeks that already happened before the feature was deployed — there's no way to retroactively snapshot a week ESPN itself has already emptied out.

## Frontend

The frontend is a single static `index.html` with no build step. It:
- Fetches `DASHBOARD_API_URL` (the `getDashboard` endpoint above) on page load
- Re-fetches every 5 minutes while the tab stays open, aligned to the backend's refresh cycle
- Renders themed matchup cards per league and a combined, points-sorted standings table (rank, team, record, win%, total points, playoff odds). Rank always reflects each team's true cross-league position — a league filter (same self-activating pill pattern as Points by Position, below) narrows which rows are *visible* without renumbering them, since this table's whole point is the combined ranking.
  - **Sort order:** primary key is season `pointsFor`, descending. Before Week 1 posts any scores, every team is tied at 0 — the tiebreak is playoff odds (`currentSimulationResults.playoffPct`, also shown as a column, displayed to 2 decimal places), descending, so the order still means something instead of just reflecting ESPN's opaque `currentProjectedRank`. That field is kept as a final fallback in case playoff odds ever ties too (e.g. before ESPN's simulation has run at all). `computeCombinedStandings()` in the backend mirrors this exact tiebreak chain, since it's also used for the weekly `standings-history` snapshot. The odds column shows 2 decimal places specifically so two teams that would otherwise look tied at whole-percent precision are distinguishable — at 2 decimals, ties are rare enough that the table doesn't currently need a shared-rank display for them.
- The same league-filter pills appear above "This Week's Matchups" (narrows which league's block of cards is shown) and the standings chart (narrows which teams' lines/legend entries are drawn — the rank axis itself stays scaled to every team, same reasoning as the standings table). All four filters (matchups, standings, position matrix, chart) share one `renderLeagueFilterPills()` helper. League order is standardized everywhere a league appears — matchup card blocks and every pill row — as ascending alphabetical by league name (`sortedLeagueColors()`), rather than each section's own incidental data order (e.g. standings sorted by points, chart by team).
- Each league's pill is tinted with that league's own color (`.pill-${color}`, using the same `--red`/`--blue` tint variables as the table rows) so it's visually identifiable at a glance; "All Leagues" stays neutral. Selected uses the stronger `-tint-strong` shade rather than a solid fill, matching the table row hover treatment instead of introducing a new, brighter look.
- Within a league's block, matchup cards are sorted ascending alphabetically by the home team's name — ESPN's own `schedule` order is really just matchup-id order, not anything meaningful to show.
- Each league's banner shows "Week Projected" (combined projected points for the week), "Week Total" (combined actual points, appearing once any game in that league has started), and "Season Total" (sum of every team's season-to-date `pointsFor`)
- Highlights the team currently leading a live matchup, and the winning side of a completed week, with a subtle background tint (matching the league's red/blue) behind its name and score
- A small helmet icon next to each team name links out to that team's ESPN page; clicking the team name itself opens a modal (see below)
- Every clickable element has a hover tooltip describing what it opens

All of the popups below share one modal component (`#modalBackdrop` / `#modalDialog` in `index.html`) — only the body content differs. It's dismissible via the ✕ button, a backdrop click, or Escape, and renders as a full-width bottom sheet on narrow viewports.

### Roster lightbox

Clicking a team name in a matchup card opens a modal listing that team's roster for the current week — position, player, NFL team, kickoff time, projected points, and actual points, grouped into Starters / Bench / IR. A player flagged by ESPN as questionable, out, etc. gets a small abbreviated badge next to their name (Q, D, O, IR, DTD, SUSP, P, INACT).

Player position, roster slot, and NFL team are resolved from ESPN's undocumented-but-stable numeric ID tables (`POSITION_NAMES`, `SLOT_NAMES`, `PRO_TEAM_ABBR` near the top of the `<script>` block). If ESPN adds a new slot type, the lookup falls back to `—` rather than erroring — extend the relevant map if a new ID shows up.

**Game time:** each player's row shows their NFL team's kickoff time (`gameTimeLabel()`), from `gameStatus[nflTeam].date` (see Live Scoring, below) — a stable ISO timestamp from the scoreboard API, formatted in the *viewer's own local timezone*, not a hardcoded one. Deliberately uses the raw kickoff `date` rather than ESPN's own preformatted status strings, since those shift to "Final" or "Q2 5:26" once a game starts, which wouldn't stay a useful "when do they play" answer. Only shown for the current week — `gameStatus` reflects live data, not history, so the Week-N-snapshot version of this modal (`rosterRowFromHistory`, for past weeks) doesn't have a Game column.

### Score history

Clicking a team name in the Combined Standings table opens that team's season history — one row per completed week (opponent, score for/against, W/L/T), sourced by walking `league.data.schedule` for every `matchupPeriodId` before the current week (there's no separate "history" endpoint; the schedule already holds every week). The "For" score is tinted in the league's color on weeks that team won, same treatment as the matchup-card winning highlight.

### Matchup comparison

Clicking the small "vs" glyph between the two teams on a matchup card, or a week number inside the score-history modal, opens a side-by-side comparison: both teams' full rosters (same Pos/Player/Team/Proj/Actual table as the roster lightbox) for that specific week, with the winning team's header tinted.

For the current week, rosters come live from `leagues`. For a past week, they come from that week's `roster-history` snapshot instead (see Firestore below) — a small note ("From the Week N roster snapshot...") marks this. If no snapshot exists for the requested week (it predates this feature, or a write failed), that side shows "No roster snapshot available for this week" rather than erroring or showing something misleading.

### Live Scoring

Above "Points by Position," a leaderboard of every rostered **starter** (bench/IR excluded) whose real NFL team is currently mid-game and who has **actually scored** (a scoreless-but-playing starter doesn't show) — `Team — Position Player — Points`, sorted highest points first. Entirely self-hiding: the whole section, heading included, disappears when nobody rostered is currently playing, which is the common case most of the week.

"Currently mid-game" comes from a **second, separate ESPN API** — the public NFL scoreboard (`site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`, unauthenticated, distinct from the fantasy API used everywhere else in this app) — cross-referenced against each player's `proTeamId` (via `PRO_TEAM_ABBR`) to check whether their team's game `status.type.state` is `'in'`. This is a real live/finished/upcoming signal, unlike the fantasy API's own per-player stats, which only say whether ESPN has posted *any* stat for a player this week — that doesn't distinguish a game still in progress from one that already ended. See `fetchNflGameStatus()` in `index.js` — the same per-team status (remaining game clock and kickoff time) it returns also drives the matchup-card Currently Playing / Yet to Play / Mins Left metrics and the roster modal's per-player game time (both below), so there's one scoreboard fetch per refresh cycle, not one per feature.

A small green dot next to a player's name means they scored in the last 5-minute refresh — compares this cycle's points to the previous cycle's, stored in `fantasy-dashboard/live-scoring-prev` (see Firestore above), since a Cloud Function doesn't retain memory between invocations and the indicator is meant to track the backend's own refresh cadence, not "since this browser tab last polled."

Same league-filter pills and red/blue row tinting as every other section (`renderLeagueFilterPills()`, `tr.row-red`/`tr.row-blue`).

### Points by position

Below "This Week's Matchups," a matrix table: one row per team (combined across leagues, sorted alphabetically by team name), one column per real position (QB/RB/WR/TE/D-ST/K/HC — a FLEX-WR counts under WR, not a separate FLEX column). Each cell is that position's summed **actual** points for the selected week (falls back to summed projected, shown in italics, before kickoff). Built entirely from the same per-game roster data already used by the roster lightbox.

- **Team owner:** each row's team name is followed by the manager's name, same treatment as Combined Standings (`memberName()` / `.team-owner`).
- **Week selector:** a dropdown above the table lists every week from 1 through the current one, defaulting to the current week. Picking a week is "sticky" across the page's 5-minute auto-refresh (it won't snap back to current on its own) until you pick "(Current)" again, which returns it to always tracking the live current week.
- **Past weeks come from `roster-history`:** the current week reads live roster data; any other week reads that week's snapshot instead (same as Matchup Comparison — see Firestore below for why this is necessary). If no snapshot exists for a requested week, the table shows an explicit "no snapshot" message rather than silently rendering nothing.
- **Multi-player cells:** a team starting 2 RBs sums to one RB total; hovering a cell (native `title` tooltip) or clicking it (opens the shared modal, labeled with the selected week) shows the per-player breakdown behind that number.
- **League filter:** pill buttons ("All Leagues" / each league by name) above the table filter which rows show. Only appears once more than one league has data — with a single league it'd just be a redundant "All" vs. itself, so it self-activates once League 2 joins rather than needing a code change.
- **Total row:** a bottom row sums each position across every currently-visible team (respects the league filter above, same as the per-team rows do). Clicking a total cell opens the shared modal listing every starter at that position across those teams, tagged with which team they belong to, sorted alphabetically by team name. A position with zero starters anywhere (e.g. a league whose lineups aren't set yet) shows `—` and isn't clickable, same treatment as an empty per-team cell.

> **Manager name casing:** ESPN member names come back in whatever casing the person typed at sign-up (often all-caps). `memberName()` (frontend) runs every manager name through `toTitleCase()` before display, so "ADAM HOSKINS" and "adam hoskins" both render as "Adam Hoskins" everywhere a manager name appears (Combined Standings, Points by Position). The backend stores the raw ESPN casing in `roster-history`; only the frontend normalizes it, so there's one place to keep in sync if the rule ever changes.

### Standings trend chart

Below the standings table, a hand-rolled inline SVG line chart (no charting library — this project has no external JS dependencies) plots each team's combined rank across the season, built from `payload.standingsHistory`: X-axis is week (labeled "Week"), Y-axis is rank (labeled "Rank (1 = best)", inverted so rank 1 is at the top), one line per team.

- **Color:** each league gets a base hue (red/blue), with lightness spread across that league's teams (`teamLineColor()`), so the palette scales automatically as teams/leagues are added instead of a hardcoded N-color list.
- **League filter:** the same self-activating pill row as elsewhere narrows which teams' lines/legend entries are drawn at all. Switching it clears any active team selection (below), since a selected-but-now-hidden team would otherwise be a confusing state.
- **Team selection:** multi-select (`selectedChartTeamIds`, a `Set`) — clicking a legend chip, a line, or a specific point toggles that team into or out of the shown set. With nothing selected, all (league-filtered) teams show. Once one or more are selected, every *other* team's line and points are fully hidden (not just dimmed), so comparing a handful of specific teams out of 16+ stays legible. "Show all" clears the set. This is click/tap-driven rather than hover-only, since hover doesn't exist on touch.
- **Per-point detail:** each point carries a native SVG `<title>` (team, week, rank, points) shown on hover — no custom tooltip UI needed. It's the browser's own native tooltip (same as any HTML `title` attribute elsewhere in the app, e.g. matrix cells), so its hover delay isn't something this app controls.
- **Rank axis:** every rank from 1 to the total team count gets its own label (no skipping, regardless of how many teams there are), with a dim horizontal gridline at each one (`.chart-gridline-h`, 40% opacity) so a point's exact rank is easy to read off the axis without hovering it.
- **Preseason starting point:** the leftmost point is usually week 0 — the seeded `standings-history/0` preseason snapshot (see Firestore above) — labeled "Pre" on the axis and "Preseason" in point tooltips rather than a literal "0", since there's no real NFL Week 0.
- **Empty state:** shows a placeholder message until at least one week has completed.

> **Team identity across leagues:** ESPN's numeric team `id` is only unique *within* one league — two independently-created leagues can (and likely will) both have a team with id `1`. Both the chart and the position matrix key teams by `${leagueColor}:${teamId}`, not the raw id, so teams from different leagues never collide into one line/row. Keep this in mind if you add another feature that indexes teams by id.

### Matchup card metrics

| Metric | Status |
|---|---|
| Projected | Direct from ESPN's `totalProjectedPoints`. Fully working. |
| Currently Playing / Yet to Play | Computed client-side from each team's starting lineup (`rosterForCurrentScoringPeriod.entries`, excluding bench/IR), driven by `gameStatus` (see Live Scoring, above) — a starter counts as "Currently Playing" if their NFL team's game `state` is `'in'`, or "Yet to Play" if `'pre'`. A starter whose team isn't in `gameStatus` at all (bye week, or the scoreboard fetch failed that cycle) counts toward neither. Used to be inferred from whether ESPN had posted any stat for the player, which conflated "still playing" with "already finished" and miscounted bye-week players as "yet to play." |
| Mins Left | Time remaining until this team's **last** currently-playing starter's game ends (a max across their active games' remaining clock, not a sum, since a team's starters can be in different simultaneous games) — `—` when nobody on the team is currently playing. Built from the same `gameStatus.secondsRemaining` used above (`secondsRemainingInGame()` in the backend converts ESPN's per-quarter clock into "time left in the whole game"). |

### Onboarding tour

A 5-slide walkthrough (`TOUR_STEPS` in `index.html`) auto-shows once per browser on first visit (tracked via `localStorage['ff-tour-seen-v1']`, so it's per-browser, not a real login) and is replayable anytime via the "What's New" link next to the build number in the footer. It reuses the shared modal component and illustrates each major feature (matchups, points by position, combined standings, standings trend) with made-up example teams/leagues rather than the viewer's real data, so it reads as generic illustration.

Mockup content inside the tour uses dedicated `.tour-mockup-*` classes only — never the real interactive classes (`.roster-trigger`, etc.) — so nothing inside a tour slide can accidentally trigger the dashboard's real click handlers. Bump `TOUR_VERSION` (and its derived storage key) if a future redesign should re-show the tour to everyone once, without needing to clear anyone's `localStorage`.

### Versioning

The dashboard displays its build number in a footer at the bottom of the page ("Build vX.Y"), sourced from the `BUILD_VERSION` constant near the top of the `<script>` block in `index.html`.

**Scheme:** `vMAJOR.MINOR`
- Bump **MINOR** for routine updates — bug fixes, small UI tweaks, metric changes
- Bump **MAJOR** for significant changes — new features, redesigns, or backend contract changes that affect the frontend

Bump `BUILD_VERSION` on every deploy that changes `index.html`, before running `firebase deploy`, so the footer always reflects what's actually live.

## League Configuration

Currently active:
- **League 1 (red):** "Sacking John Since Draft Day" — ID `566236785` — public
- **League 2 (blue):** "Hoskins: No Mercy, No Waivers" — ID `101181062` — public

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
