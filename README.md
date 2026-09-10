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

**`heartbeat`** — public, called by the frontend on a ~25s interval (not the 5-min dashboard refresh cycle)
- Upserts a `presence/{sessionId}` doc (a random per-tab ID, no PII) with the current timestamp, opportunistically deletes any doc that's gone stale, and returns how many are still active — powers the "currently viewing" count in the page's top-left corner (see Frontend below)
- URL: `https://us-central1-fantasy2026.cloudfunctions.net/heartbeat`
- `sessionId` is validated against a strict `[A-Za-z0-9-]` allowlist before being used as a Firestore path segment, not just checked for length — it's a UUID or UUID-shaped fallback string, so a legitimate caller is never rejected

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

**`presence/{sessionId}`** — one doc per open tab, written by the `heartbeat` function (not `refreshLeagues` — this is the one collection not tied to the 5-min cache cycle): `{ lastSeen }`, a plain millisecond timestamp. No Firestore TTL policy — `heartbeat` deletes any doc it finds older than 90 seconds inline, every time it runs, so the collection self-cleans without needing one configured.

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
- Re-fetches every 5 minutes while the tab stays open, aligned to the backend's refresh cycle but offset 45 seconds *past* each `:00/:05/:10...` mark, not polling exactly on it (`scheduleAlignedRefresh()`, `REFRESH_ALIGN_OFFSET_MS`) — the backend's own 5-min cron doesn't start atomically at the mark either: Cloud Scheduler dispatch, cold starts, and queueing routinely push `refreshLeagues`'s actual start anywhere from 3 to 55 seconds past the mark (measured from its own invocation logs), plus ~7-8s more for the ESPN-fetch-and-Firestore-write itself. Polling right at `:00` instead of after that window reliably raced ahead of the backend's write and read the *previous* cycle's still-cached data — the fetch itself succeeds, so nothing looks broken client-side, but the content stays a full cycle stale until the next poll. Caught live, reported as "so its 11:04 and the data is from 10:55" (and recurring after the fix below, at 11:21/11:15) before the race was identified as a distinct cause.

  That `setInterval` also can't be trusted to have actually fired on schedule at all, separately from the race above — a browser throttles or fully suspends timers in a backgrounded tab, and a system sleep (lid closed, display suspended) can freeze them for the sleep's whole duration *without necessarily firing `visibilitychange` on wake either*, unlike a plain tab switch. Caught live: data sat 6 minutes stale on a tab the DOM never reported as anything but `'visible'`.

  Rather than trying to make the interval itself sleep-proof, `checkDashboardStaleness()` just asks "is the data actually current?" using real elapsed wall-clock time (`Date.now() - lastDashboardLoadAt`, `lastDashboardLoadAt` being a plain timestamp set on every successful load — not timer bookkeeping) against a 5.5-minute threshold (a bit of slack over the 5-min cadence so a fetch merely running a little behind doesn't trigger a redundant extra one). This check piggybacks on the viewer-count heartbeat's own 25s tick (`heartbeatTick()`, wrapping both `sendHeartbeat()` and the staleness check) — already the most reliable recurring signal in the app, since it only runs while the tab is genuinely visible (pausing/resuming on `visibilitychange`) and fires immediately on `startHeartbeat()`. So even a tab that silently slept through a `visibilitychange` self-heals within one heartbeat tick (≤25s) of actually resuming execution, instead of depending on an event that isn't guaranteed to fire at all.
- Renders themed matchup cards per league and a combined, points-sorted standings table (rank, team, record, win%, total points, playoff odds). Rank always reflects each team's true cross-league position — a league filter (same self-activating pill pattern as Points by Position, below) narrows which rows are *visible* without renumbering them, since this table's whole point is the combined ranking.
  - **Sort order:** primary key is season `pointsFor`, descending. Before Week 1 posts any scores, every team is tied at 0 — the tiebreak is playoff odds (`currentSimulationResults.playoffPct`, also shown as a column, displayed to 2 decimal places), descending, so the order still means something instead of just reflecting ESPN's opaque `currentProjectedRank`. That field is kept as a final fallback in case playoff odds ever ties too (e.g. before ESPN's simulation has run at all). `computeCombinedStandings()` in the backend mirrors this exact tiebreak chain, since it's also used for the weekly `standings-history` snapshot. The odds column shows 2 decimal places specifically so two teams that would otherwise look tied at whole-percent precision are distinguishable — at 2 decimals, ties are rare enough that the table doesn't currently need a shared-rank display for them.
- The same league-filter pills appear above "This Week's Matchups" (narrows which league's block of cards is shown) and the standings chart (narrows which teams' lines/legend entries are drawn — the rank axis itself stays scaled to every team, same reasoning as the standings table). All four filters (matchups, standings, position matrix, chart) share one `renderLeagueFilterPills()` helper. League order is standardized everywhere a league appears — matchup card blocks and every pill row — as ascending alphabetical by league name (`sortedLeagueColors()`), rather than each section's own incidental data order (e.g. standings sorted by points, chart by team).
- Each league's pill is tinted with that league's own color (`.pill-${color}`, using the same `--red`/`--blue` tint variables as the table rows) so it's visually identifiable at a glance; "All Leagues" stays neutral. Selected uses the stronger `-tint-strong` shade rather than a solid fill, matching the table row hover treatment instead of introducing a new, brighter look.
- Within a league's block, matchup cards are sorted ascending alphabetically by the home team's name — ESPN's own `schedule` order is really just matchup-id order, not anything meaningful to show.
- Each league's banner shows "Week Projected" (combined projected points for the week), "Week Total" (combined actual points, appearing once any game in that league has started), and "Season Total" (every team's season-to-date `pointsFor` plus the current week's live total)

> **Note:** ESPN's own `totalPoints` field on a schedule matchup side — what matchup-card scores, the Week Total line, and (via `pointsFor`, which also only counts finalized weeks) Season Total all ultimately read — stays frozen at 0 for the current week until ESPN officially finalizes it (stat corrections locked, usually the following Tuesday). It is not a live score, despite `mMatchupScore` being one of the requested `ESPN_VIEWS`. The backend now patches `totalPoints` for the current week only (past weeks are left as ESPN's own authoritative final numbers) with `pointsByScoringPeriod[currentWeek]` — a *different* ESPN field on the same object that does update live, confirmed to exactly match a from-scratch resum of that team's starters' own actual stats (`patchLiveMatchupTotals()` in the backend). Since every current-week consumer reads the same `totalPoints` field, this one patch fixes matchup cards, the Week Total line, and (combined with adding the current week's now-live total on the frontend) Season Total all at once.
- Highlights the team currently leading a live matchup, and the winning side of a completed week, with a subtle background tint (matching the league's red/blue) behind its name and score
- A small helmet icon next to each team name links out to that team's ESPN page; clicking the team name itself opens a modal (see below)
- Every clickable element has a hover tooltip describing what it opens
- **Collapsible sections:** every top-level section (This Week's Matchups, Live Scoring, Points by Position, Combined Standings, Standings Trend) has a minimize/maximize chevron in its header (`CHEVRON_SVG`, rotated via CSS rather than swapped for a different icon). Collapsing hides only that section's `.section-body` — the title stays visible so you can still see and re-expand it. Because the toggle wraps *around* each section's own render function rather than being recreated by it, collapse state survives the 5-min auto-refresh automatically; it's also persisted to `localStorage` (`ff-section-collapsed-<sectionId>`, same mechanism as the onboarding tour's "seen it" flag) so it survives a page reload too.
- **Section nav:** a row of links under the `<h1>` (`#sectionNav`), one per top-level section, smooth-scrolling to it on click (`[data-nav-section]`, delegated in the same document click handler as everything else). If the target section is currently collapsed, the nav expands it first (and persists that, same as clicking its own chevron) rather than scrolling to a bare header with nothing under it. **Live Scoring** is the one entry that isn't always there — `#navLiveScoring` is toggled `hidden` in lockstep with the section's own self-hiding (`renderLiveScoringBoard()`: both flip together off `liveScoring.length`), so the nav never links to a section that isn't currently showing anything. While it's there, it gets an "on the air" treatment to stand out from the other (static, gray) entries — bold `--live` green, a small dot before the text (`::before`), and a slow 2.2s opacity pulse (`@keyframes navLivePulse`), all pure CSS keyed off the same `#navLiveScoring` element so there's nothing extra to keep in sync. Respects `prefers-reduced-motion` (pulse disabled, color/dot/bold stay).
- **"Currently viewing" count:** a small glasses icon + count, fixed to the very top-left corner of the page, light gray. This app has no real-time/WebSocket layer, so it's a heartbeat, not a live subscription — each tab pings the `heartbeat` function every ~25s with a random per-tab ID (see Backend above), and shows back however many tabs pinged in the last 90 seconds. Heartbeats pause whenever the tab is hidden (Page Visibility API) and resume immediately when it becomes visible again, rather than on a fixed timer, since a backgrounded tab isn't really being "viewed." A failed heartbeat just leaves the last known count on screen rather than clearing it or showing an error — a background nicety's hiccup isn't worth interrupting anyone over.
- **"Last updated" is fixed to the same top-left corner, stacked directly above the viewer count** (`#lastUpdated`, `position: fixed; top: 10px`; `#viewerCount` sits at `top: 30px` to clear it) — both stay on screen while scrolling instead of scrolling away with the rest of the page, same reasoning for both: it's context worth having visible at a glance no matter where you've scrolled to. `body`'s own top padding was bumped from 28px to 56px so the `<h1>` still clears the now-two-line stack instead of running underneath it.

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

Above "Points by Position," a leaderboard of every rostered **starter** (bench/IR excluded) whose real NFL team is currently mid-game and who has **actually scored** (a scoreless-but-playing starter doesn't show) — `Team — Name - NFL team - Position — Points` (e.g. "Josh Allen - BUF - QB"), sorted highest points first. Entirely self-hiding: the whole section, heading included, disappears when nobody rostered is currently playing, which is the common case most of the week.

"Currently mid-game" comes from a **second, separate ESPN API** — the public NFL scoreboard (`site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`, unauthenticated, distinct from the fantasy API used everywhere else in this app) — cross-referenced against each player's `proTeamId` (via `PRO_TEAM_ABBR`) to check whether their team's game `status.type.state` is `'in'`. This is a real live/finished/upcoming signal, unlike the fantasy API's own per-player stats, which only say whether ESPN has posted *any* stat for a player this week — that doesn't distinguish a game still in progress from one that already ended. See `fetchNflGameStatus()` in `index.js` — the same per-team status (remaining game clock and kickoff time) it returns also drives the matchup-card Currently Playing / Yet to Play / Mins Left metrics and the roster modal's per-player game time (both below), so there's one scoreboard fetch per refresh cycle, not one per feature.

A small triangle next to a player's name shows how their points moved in the last 5-minute refresh — green pointing up if they scored more, red pointing down on the rarer case of a downward stat correction, nothing if unchanged — compares this cycle's points to the previous cycle's, stored in `fantasy-dashboard/live-scoring-prev` (see Firestore above), since a Cloud Function doesn't retain memory between invocations and the indicator is meant to track the backend's own refresh cadence, not "since this browser tab last polled." Backend computes this as `trend: 'up' | 'down' | null` (`buildLiveScoringBoard()`); the frontend just picks the CSS class, no comparison logic on its own.

> **Note:** originally just a green dot meaning "changed since last update" (in practice only ever an increase, since points historically only went up). Changed to a directional up/red-down arrow so a decrease — an ESPN stat correction revising `appliedTotal` downward within the same live window — reads distinctly from an increase instead of looking identical to one.

Same league-filter pills as every other section (`renderLeagueFilterPills()`); unlike Combined Standings and Points by Position, rows themselves are left plain (no `row-red`/`row-blue` background tint) — only each team name's *text* is color-coded, in the exact per-team shade its chip uses in the team filter below (`teamLineColorForTeam()`), not a flat league red/blue.

- **Team filter:** a second row of pill chips, one per team currently on the board — reuses the standings chart's own `.chart-legend-chip`/`.chart-legend-swatch` markup (not the league pills' red/blue-border `.filter-pill` style), with each chip's swatch dot colored by `teamLineColorForTeam()`, a wrapper around the chart's `teamLineColor()` shading keyed off the live team roster instead of a `standingsHistory` snapshot. A team's chip is therefore visually identical, dot color included, wherever it appears on the page, not just similarly styled. Click one or more chips to isolate just those teams' players, mirroring the standings chart's team multi-select (`selectedLiveScoringTeamKeys`, a `Set`, same pattern as `selectedChartTeamIds`). "Show all" clears it. Switching the league filter also clears the team selection, since a team selected in a now-hidden league would be a confusing state.

  > **Note:** an earlier version of this sized the team chips down to match but kept the league pills' colored-border/text style (`.filter-pill.compact`) — closer, but still visibly a different treatment (solid red/blue border+text vs. a neutral chip with a small colored dot), not the same component. Switched to actually reusing `.chart-legend-chip` itself.
- **Pagination:** only the top 25 (of whatever's currently filtered) render at a time, with a "Show 25 more" button below and a "Showing X of Y" count — this data can grow to hundreds of rows by the end of a Sunday, and re-rendering all of them every 5-minute refresh would both flood the screen and get slower as the day goes on. `liveScoringVisibleCount` persists across the auto-refresh (an expanded view doesn't collapse back to 25 on its own), but resets to 25 whenever the league or team filter actually changes, since that's effectively a new view.
- **Shared players across leagues:** the two leagues are drafted independently, so the same real NFL player can be rostered by a team in each at once — same real stat line, so always the same points. `groupLiveScoringByPlayer()` groups the board by `playerId` before display, so a shared player gets one row naming every team that has them — each on its own line (a block-level `.live-scoring-team-name` span per team, not a comma-joined `Team A, Team B`), sorted ascending by team name, each in its own `teamLineColorForTeam()` shade — instead of two duplicate-looking rows. With the team filter active, a shared player's row still shows if *any* of their teams is selected, but only the selected team(s) are named on that row — not one you didn't ask to isolate.

  > **Note:** an earlier version of this tinted a single-team row's whole background red/blue (`tr.row-red`/`tr.row-blue`, same as Combined Standings and Points by Position) and colored team names by flat league color (`.live-scoring-team-name.pill-red`/`.pill-blue`). Per feedback, rows are plain now and names use the per-team shade instead, to match the team-filter chips exactly.

### Points by position

Below "This Week's Matchups," a matrix table: one row per team (combined across leagues, sorted alphabetically by team name), one column per real position (QB/RB/WR/TE/D-ST/K/HC — a FLEX-WR counts under WR, not a separate FLEX column). Each cell shows that position's **actual points scored so far** — once *any* starter at that position has played, the total is the sum of real stats only, and anyone who hasn't played yet contributes nothing to it (not their projection). Only while *literally nobody* at that position has played yet does the cell fall back to a summed projection, as a pre-kickoff estimate. `emptyPositionBuckets()`/`finalizePositionBuckets()` accumulate both an actual-sum and a projected-sum per bucket while walking the roster, then pick one at the end (`hasActual` decides which) — since which sum to display isn't known until every player in the group has been seen. Italic (`matrix-projected`) means "this number is a projection" and only applies while `hasActual` is false — nobody at that position has played, so the total is a pure pre-kickoff estimate. A "partial" cell (some starters played, some haven't) is deliberately **not** italicized, even though it isn't the week's final tally yet (`allActual` is false) — its total is 100% real data now, just incomplete, and italicizing a fully-real number the same way as a guess would misrepresent it. The click-through modal's text label carries the completeness nuance instead: `(projected)` when nobody's played, `(partial)` when some have and some haven't, or nothing once everyone has — `allActual` drives that label, `hasActual` drives the font style, and they're deliberately different conditions. Hovering (or the modal) still breaks down each player's own actual-or-projected value individually, so it's clear what's real vs. still an estimate even though the headline total only counts the real part. Built entirely from the same per-game roster data already used by the roster lightbox.

> **Note:** two earlier attempts at this got it wrong, both caught live. The first blended actual-where-available with projected-as-filler into one total, only italicizing once *every* player had a real stat — a cell showing a solid 30.4 was actually 2.3 real plus ~28 points of projections for two players who hadn't played yet. The second fixed the total to be actual-only, but kept italicizing it whenever it wasn't the final tally — so a cell showing a fully-real 4.1 was italicized as if it might not be real, which was just as misleading in the other direction. The current behavior (total = real data only; italic = is it a projection, not is it final) is the result of both corrections.

- **Team owner:** each row's team name is followed by the manager's name, same treatment as Combined Standings (`memberName()` / `.team-owner`).
- **Week selector:** a dropdown above the table lists every week from 1 through the current one, defaulting to the current week. Picking a week is "sticky" across the page's 5-minute auto-refresh (it won't snap back to current on its own) until you pick "(Current)" again, which returns it to always tracking the live current week.
- **Past weeks come from `roster-history`:** the current week reads live roster data; any other week reads that week's snapshot instead (same as Matchup Comparison — see Firestore below for why this is necessary). If no snapshot exists for a requested week, the table shows an explicit "no snapshot" message rather than silently rendering nothing.
- **Multi-player cells:** a team starting 2 RBs sums to one RB total; hovering a cell (native `title` tooltip) or clicking it (opens the shared modal, labeled with the selected week) shows the per-player breakdown behind that number.
- **Real points are colored in the team's own shade:** a cell showing a real (non-italic) number has its text colored via `teamLineColorForTeam()` — the same per-team shade used by that team's chip in Live Scoring's team filter and the standings chart legend — instead of plain text, so a team reads as the same color everywhere on the page. A projected (italic) cell is unaffected, keeping its existing dim `matrix-projected` color; the two treatments are mutually exclusive (a cell is either dim-italic-and-projected or team-colored-and-real, never both).
- **Total column:** each row ends with that team's own Total — same actual-only-once-anyone's-played rule as a single position cell (`finalizePositionBuckets`), but spanning every position this team has starters at (`computeRowTotal()`) rather than one position across every team. Deliberately recomputes from each starter's raw actual/projected value instead of summing the row's own already-finalized position cells — a team can easily have one position that's gone real and another still projected, and summing those decided totals would reproduce the same blended-and-inflated bug the column Total was fixed for, just scoped to one team. Not clickable (no per-team, all-positions modal exists) — a hover tooltip breaks it down by position instead. The Total row (below) gets a matching Total column of its own in the bottom-right corner: every team's Total column combined, via the same rule one level up again (`computeGrandTotal()`), also not clickable and not team-colored since it isn't any one team's number.
- **League filter:** pill buttons ("All Leagues" / each league by name) above the table filter which rows show. Only appears once more than one league has data — with a single league it'd just be a redundant "All" vs. itself, so it self-activates once League 2 joins rather than needing a code change.
- **Total row:** a bottom row sums each position across every currently-visible team (respects the league filter above, same as the per-team rows do), applying the exact same actual-only-once-anyone's-played rule as a per-team cell (`finalizePositionBuckets`) — but league-wide: once *any* team's starter at that position has real points, every other team's still-unplayed starter at that position contributes 0 to the total, not their projection; only while literally nobody league-wide has played does the total fall back to the summed projection. Clicking a total cell opens the shared modal listing every starter at that position across those teams, tagged with which team they belong to, sorted alphabetically by team name. A position with zero starters anywhere (e.g. a league whose lineups aren't set yet) shows `—` and isn't clickable, same treatment as an empty per-team cell.

  > **Note:** an earlier version summed each team's already-finalized per-team total (`bucket.total`) directly — which blended one team's real points with another team's still-projected estimate, since each team's own total independently falls back to projected until *that team's* starter at the position has played. That reproduced the same "solid-looking but mostly a guess" bug the per-cell fix addressed, one level up: a real total of 23.0 (only one team's WR had actually scored) rendered as an inflated, blended 586.4. `computePositionTotals()` now aggregates every contributing player's raw actual/projected value directly, league-wide, instead of summing each team's own already-decided total.

> **Manager name casing:** ESPN member names come back in whatever casing the person typed at sign-up (often all-caps). `memberName()` (frontend) runs every manager name through `toTitleCase()` before display, so "ADAM HOSKINS" and "adam hoskins" both render as "Adam Hoskins" everywhere a manager name appears (Combined Standings, Points by Position). The backend stores the raw ESPN casing in `roster-history`; only the frontend normalizes it, so there's one place to keep in sync if the rule ever changes.

### Standings trend chart

Below the standings table, a hand-rolled inline SVG line chart (no charting library — this project has no external JS dependencies) plots each team's combined rank across the season, built from `payload.standingsHistory`: X-axis is week (labeled "Week"), Y-axis is rank (labeled "Rank (1 = best)", inverted so rank 1 is at the top), one line per team.

- **Color:** each league gets a base hue (red/blue), with lightness spread across that league's teams (`teamLineColor()`), so the palette scales automatically as teams/leagues are added instead of a hardcoded N-color list.
- **League filter:** the same self-activating pill row as elsewhere narrows which teams' lines/legend entries are drawn at all. Switching it clears any active team selection (below), since a selected-but-now-hidden team would otherwise be a confusing state.
- **Team selection:** multi-select (`selectedChartTeamIds`, a `Set`) — clicking a legend chip, a line, or a specific point toggles that team into or out of the shown set. With nothing selected, all (league-filtered) teams show. Once one or more are selected, every *other* team's line and points are fully hidden (not just dimmed), so comparing a handful of specific teams out of 16+ stays legible. "Show all" clears the set. This is click/tap-driven rather than hover-only, since hover doesn't exist on touch.
- **Per-point detail:** each point carries a native SVG `<title>` (team, week, rank, points) shown on hover — no custom tooltip UI needed. It's the browser's own native tooltip (same as any HTML `title` attribute elsewhere in the app, e.g. matrix cells), so its hover delay isn't something this app controls.
- **Rank axis:** every rank from 1 to the total team count gets its own label (no skipping, regardless of how many teams there are), with a dim horizontal gridline at each one (`.chart-gridline-h`, 40% opacity) so a point's exact rank is easy to read off the axis without hovering it.
- **Preseason starting point:** the leftmost point is usually week 0 — the seeded `standings-history/0` preseason snapshot (see Firestore above) — labeled "Pre" on the axis and "Preseason" in point tooltips rather than a literal "0", since there's no real NFL Week 0.
- **Team renames:** a `standings-history` entry's `teamName` is frozen at whatever the team was called when that week's snapshot was written — a real problem, since ESPN lets managers rename their team mid-season and a rename can go up to a week (or forever, for the write-once preseason doc) before the next snapshot picks it up. The chart's legend/tooltips instead resolve each team's display name live (same `leagueColor:teamId` lookup used everywhere else), falling back to the snapshotted name only if the team can't be found in the current `leagues` data. The stored snapshot name itself is left alone — it's a fine historical record of "what this team was called that week" — only the chart's *display* prefers the live name.
- **Empty state:** shows a placeholder message until at least one week has completed.

> **Team identity across leagues:** ESPN's numeric team `id` is only unique *within* one league — two independently-created leagues can (and likely will) both have a team with id `1`. Both the chart and the position matrix key teams by `${leagueColor}:${teamId}`, not the raw id, so teams from different leagues never collide into one line/row. Keep this in mind if you add another feature that indexes teams by id.

### Matchup card metrics

| Metric | Status |
|---|---|
| Projected | Direct from ESPN's `totalProjectedPoints`. Fully working. |
| Currently Playing / Yet to Play | Computed client-side from each team's starting lineup (`rosterForCurrentScoringPeriod.entries`, excluding bench/IR), driven by `gameStatus` (see Live Scoring, above) — a starter counts as "Currently Playing" if their NFL team's game `state` is `'in'`, or "Yet to Play" if `'pre'`. A starter whose team isn't in `gameStatus` at all (bye week, or the scoreboard fetch failed that cycle) counts toward neither. Used to be inferred from whether ESPN had posted any stat for the player, which conflated "still playing" with "already finished" and miscounted bye-week players as "yet to play." |
| Mins Left | Time remaining until this team's **last** currently-playing starter's game ends (a max across their active games' remaining clock, not a sum, since a team's starters can be in different simultaneous games) — `—` when nobody on the team is currently playing. Built from the same `gameStatus.secondsRemaining` used above (`secondsRemainingInGame()` in the backend converts ESPN's per-quarter clock into "time left in the whole game"). |

### Onboarding tour

A 6-slide walkthrough (`TOUR_STEPS` in `index.html`) auto-shows once per browser on first visit (tracked via `localStorage['ff-tour-seen-v' + TOUR_VERSION]`, so it's per-browser, not a real login) and is replayable anytime via the "What's New" link next to the build number in the footer. It reuses the shared modal component and illustrates each major feature (matchups, points by position, combined standings, standings trend) with made-up example teams/leagues rather than the viewer's real data, so it reads as generic illustration. The last slide, "New Features," is a plain bulleted release-notes list (`.tour-feature-list`) rather than a mockup — no illustration needed for a changelog.

Mockup content inside the tour uses dedicated `.tour-mockup-*` classes only — never the real interactive classes (`.roster-trigger`, etc.) — so nothing inside a tour slide can accidentally trigger the dashboard's real click handlers. Bump `TOUR_VERSION` (and its derived storage key) if a future redesign should re-show the tour to everyone once, without needing to clear anyone's `localStorage`.

**Re-surfacing for returning visitors:** bumping `TOUR_VERSION` doesn't just re-show the tour once and forget it — the auto-show check runs on every page load and only stops once the visitor actually closes the modal (any close path marks the new version's storage key seen), so it's effectively forced until dismissed at least once, however many times they reload before then. `PREVIOUS_TOUR_STORAGE_KEY` (the *previous* version's key) lets that check tell a genuinely brand-new visitor (who gets the full tour starting at slide 1) apart from a returning one who already sat through the old version (who jumps straight to the new last slide instead of replaying the whole thing) — `startTour(stepIndex)` takes an optional starting slide for this. The manually-triggered "What's New" link always replays the full tour from slide 1 regardless.

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

`firebase.json` sets `Cache-Control: no-cache` on every path (Firebase Hosting's default for a non-fingerprinted file is `max-age=3600`, an hour). `no-cache` doesn't mean "don't cache" — it means the browser must revalidate with the server (a cheap conditional request against the ETag) before reusing a cached copy, so every deploy is visible on the very next normal reload instead of silently serving a stale copy for up to an hour. The header's `source` glob has to be `**`, not `/index.html` — Firebase Hosting's CDN caches the clean-URL root (`/`, what a browser actually requests navigating to the domain) as a separate entry from the literal `/index.html` path, so scoping the rule to just the filename leaves `/` itself still caching for an hour. Worth remembering if a just-shipped change "still looks wrong" in a browser tab that predates the deploy — a hard refresh used to be the only way to be sure; with this in place a plain reload is enough (an already-open tab may still need one manual reload to pick up the new `index.html`, since it won't re-fetch on its own until the next 5-min auto-refresh cycle re-renders from the same loaded script).

### Backend
```bash
cd fantasy-dashboard-function
gcloud functions deploy refreshLeagues --gen2 --runtime=nodejs22 --region=us-central1 --source=. --entry-point=refreshLeagues --trigger-http --no-allow-unauthenticated --project=fantasy2026
gcloud functions deploy getDashboard --gen2 --runtime=nodejs22 --region=us-central1 --source=. --entry-point=getDashboard --trigger-http --allow-unauthenticated --project=fantasy2026
gcloud functions deploy heartbeat --gen2 --runtime=nodejs22 --region=us-central1 --source=. --entry-point=heartbeat --trigger-http --allow-unauthenticated --project=fantasy2026
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
