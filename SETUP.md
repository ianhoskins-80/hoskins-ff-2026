# Setup Guide

How to provision this project from scratch — a fresh GCP backend, Firestore cache, Cloud Scheduler job, and a Firebase-hosted frontend. See [README.md](README.md) for the architecture and how to operate it day-to-day; this doc is one-time bootstrap.

Examples below use `fantasy2026` as the GCP project ID and `hoskins-ff-2026` as the Firebase project ID — substitute your own.

## Prerequisites

- [`gcloud` CLI](https://cloud.google.com/sdk/docs/install), authenticated (`gcloud auth login`)
- [`firebase` CLI](https://firebase.google.com/docs/cli) (`npm install -g firebase-tools`), authenticated (`firebase login`)
- A Google Cloud **billing account** — Cloud Functions gen2 and Cloud Scheduler both require billing enabled
- Node 22 (for local testing of the function; deploys run in GCP's own build environment)

## 1. Create the backend GCP project

```bash
gcloud projects create fantasy2026
gcloud config set project fantasy2026
gcloud billing projects link fantasy2026 --billing-account=YOUR_BILLING_ACCOUNT_ID
```

## 2. Enable required APIs

```bash
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  cloudscheduler.googleapis.com \
  --project=fantasy2026
```

## 3. Create the Firestore database

```bash
gcloud firestore databases create \
  --database="(default)" \
  --location=us-central1 \
  --type=firestore-native \
  --project=fantasy2026
```

## 4. Deploy the Cloud Functions

From `fantasy-dashboard-function/`, with `LEAGUES` in `index.js` set to your league ID(s):

```bash
cd fantasy-dashboard-function

gcloud functions deploy refreshLeagues \
  --gen2 --runtime=nodejs22 --region=us-central1 --source=. \
  --entry-point=refreshLeagues --trigger-http \
  --no-allow-unauthenticated \
  --project=fantasy2026

gcloud functions deploy getDashboard \
  --gen2 --runtime=nodejs22 --region=us-central1 --source=. \
  --entry-point=getDashboard --trigger-http \
  --allow-unauthenticated \
  --project=fantasy2026
```

`refreshLeagues` stays private (invoked only by the scheduler below); `getDashboard` is public so the frontend can call it directly.

Grab `getDashboard`'s URL for later (the frontend needs it):
```bash
gcloud functions describe getDashboard --region=us-central1 --project=fantasy2026 --format="value(serviceConfig.uri)"
```

## 5. Create a service account for the scheduler

```bash
gcloud iam service-accounts create dashboard-scheduler \
  --display-name="Fantasy Dashboard Scheduler" \
  --project=fantasy2026

gcloud functions add-invoker-policy-binding refreshLeagues \
  --region=us-central1 \
  --member="serviceAccount:dashboard-scheduler@fantasy2026.iam.gserviceaccount.com" \
  --project=fantasy2026
```

## 6. Create the Cloud Scheduler job

Get `refreshLeagues`'s URL first:
```bash
gcloud functions describe refreshLeagues --region=us-central1 --project=fantasy2026 --format="value(serviceConfig.uri)"
```

Then create a job that hits it every 5 minutes, authenticated as the service account from step 5:

```bash
gcloud scheduler jobs create http refresh-fantasy-leagues \
  --location=us-central1 \
  --schedule="*/5 * * * *" \
  --uri="REFRESH_LEAGUES_URL_FROM_ABOVE" \
  --http-method=POST \
  --oidc-service-account-email="dashboard-scheduler@fantasy2026.iam.gserviceaccount.com" \
  --project=fantasy2026
```

Trigger it once manually to populate the cache immediately, rather than waiting for the next 5-minute mark:
```bash
gcloud scheduler jobs run refresh-fantasy-leagues --location=us-central1 --project=fantasy2026
```

## 7. Create the Firebase project for Hosting

Firebase Hosting is kept in its **own** Firebase project rather than attached to the GCP backend project — attaching Firebase to an existing non-Firebase GCP project can fail with a 403 even as Owner. A fresh, dedicated project sidesteps that:

```bash
firebase projects:create hoskins-ff-2026
```

## 8. Configure and initialize Hosting

From `fantasy-dashboard-site/`:
```bash
cd fantasy-dashboard-site
firebase use --add
# select hoskins-ff-2026, alias it "default"
```

This generates `.firebaserc`. `firebase.json` should look like:
```json
{
  "hosting": {
    "public": ".",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"]
  }
}
```

## 9. Point the frontend at the backend

In `index.html`, set `DASHBOARD_API_URL` to the `getDashboard` URL from step 4:
```js
const DASHBOARD_API_URL = 'https://us-central1-fantasy2026.cloudfunctions.net/getDashboard';
```

## 10. Deploy the frontend

```bash
firebase deploy --only hosting
```

## Verify

```bash
curl "https://us-central1-fantasy2026.cloudfunctions.net/getDashboard"
```
Should return JSON with a `leagues` array and a recent `updatedAt` timestamp. Then open the Hosting URL printed by the deploy command and confirm the dashboard renders.
