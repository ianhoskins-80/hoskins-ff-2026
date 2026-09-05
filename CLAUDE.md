# Working on this project

This is a personal fantasy football dashboard: a static frontend (Firebase Hosting) backed by two Cloud Functions and Firestore (see [README.md](README.md) for architecture, [SETUP.md](SETUP.md) for from-scratch bootstrap).

## Standing workflow for any code change

Follow this for every change unless the user explicitly asks for something smaller (e.g. "just show me," a doc-only tweak, or an explicit one-off). Don't ask permission to follow it — it's the default.

1. **Design** — for anything non-trivial, propose the approach and open design questions before writing code. Wait for a go-ahead. Skip this step only for small, unambiguous changes.
2. **Create branch** — off `main`, named for the change (`feature/...`, `fix/...`, `chore/...`).
3. **Code** — implement on that branch.
4. **Test** — run it locally before considering it done:
   - Backend logic: unit-test pure functions in isolation (`node -e ...`) where practical.
   - Frontend: serve `fantasy-dashboard-site/` with a local static server, drive it in the browser tool, and actually exercise the change (not just eyeball it) — click paths, check `read_console_messages` for errors, check mobile viewport when layout is involved.
   - Check for regressions in existing features, not just the new one.
5. **Security scan and fix** — review the diff for the categories in the `security-review` skill (XSS via unescaped ESPN-sourced strings is the recurring one in this codebase — team/league/owner/player names must go through `escapeHtml()` before hitting `innerHTML`). Fix anything found before proceeding.
6. **Document** — update `README.md` (and `SETUP.md` if setup steps changed) to reflect the change. Bump `BUILD_VERSION` in `index.html` if the frontend changed (MINOR for routine tweaks, MAJOR for new features — see README's Versioning section).
7. **Commit, merge, push** — commit on the branch, merge `--no-ff` into `main`, push to GitHub.
8. **Deploy** — only what actually changed:
   - Frontend touched → `cd fantasy-dashboard-site && firebase deploy --only hosting`
   - Backend touched → redeploy both Cloud Functions (see README's Deployment section for the exact `gcloud functions deploy` commands) — `getDashboard` and `refreshLeagues` are deployed independently but usually change together
   - Don't deploy what didn't change (e.g. a docs-only or backend-only commit doesn't need a hosting deploy).
9. **Verify in production** — after deploying, actually check: `curl` the live `getDashboard` endpoint and/or load the live site and confirm the change is there (e.g. check `BUILD_VERSION` in the deployed HTML matches what was just shipped, check for console errors on the live page).
10. **Clean up the branch** — delete the local (and remote, if pushed) feature branch once merged.

Report back when it's fully in production — don't stop at "pushed to GitHub."

## Notes specific to this codebase

- The frontend is a single static `index.html`, zero external JS dependencies, zero build step. Keep it that way unless the user explicitly agrees to add a dependency.
- ESPN's numeric team `id` is only unique *within* one league, not globally — key anything indexed by team across leagues as `` `${leagueColor}:${teamId}` ``, not the raw id (see README's "Team identity across leagues" note — this was a real shipped bug once).
- Don't guess at ESPN API shapes — check the live cached response (`curl https://us-central1-fantasy2026.cloudfunctions.net/getDashboard`) or ask before assuming a field exists.
