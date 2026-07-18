# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev        # tsx watch src/server.ts — auto-restart on changes (port 4000 by default)
npm start          # production run
npm run build      # tsc compile check (outputs to dist/ per tsconfig) — currently fails, see Deployment
npm run typecheck  # tsc --noEmit — type-check without emitting
```

There are no automated tests. Manual testing is done via the browser at `http://localhost:4000` (the default `PORT`; see Environment variables).

## Architecture

Single-process Express 4 server written in TypeScript. No frontend framework — the dashboard is a self-contained HTML string inlined at the bottom of `src/server.ts`. The app boots by calling `initMedplum()`; if it can't authenticate to Medplum, the process exits before `app.listen()` runs (see `src/server.ts` "Boot" section) — a live, reachable Medplum server is a hard startup dependency, not an optional store.

### Data flow

```
Browser → GET /connect/:providerId?member=UUID
         → ehr-connect.ts: fhirclient discovers SMART config, redirects to EHR login (PKCE state in express-session)
         → EHR redirects back to GET /callback?code=...&state=...
         → ehr-connect.ts: fhirclient exchanges code for tokens
         → fhir-client.ts: syncPatientData() pulls all FHIR resources from the EHR
         → medplum-client.ts: patient + resources upserted into Medplum (FHIR store)
```

### Module responsibilities

| File | Purpose |
|------|---------|
| `src/config.ts` | `ProviderConfig[]` entries for Epic/Oracle sandbox + `APP_CONFIG` from env |
| `src/types.ts` | TypeScript interfaces: SMART discovery/token types, FHIR R4 resource shapes |
| `src/ehr-connect.ts` | **Actual OAuth handlers** wired into `server.ts` (`startConnect`, `handleCallback`) — uses the `fhirclient` npm package for SMART discovery, PKCE, and token exchange; stores pending state in the Express session, not in memory |
| `src/fhir-client.ts` | Paginated FHIR R4 fetchers + `syncPatientData()`, which fetches all resource types in parallel via `Promise.allSettled` (a 403/timeout on one resource type doesn't fail the whole sync) |
| `src/medplum-client.ts` | Singleton `MedplumClient` — client-credentials login (`initMedplum()`), all Patient/EHR-connection/record read-write helpers against the Medplum FHIR API |
| `src/server.ts` | Express routes + inline dashboard HTML |
| `src/session.d.ts` | Augments `express-session`'s `SessionData` with `pendingMemberId` / `pendingProvider` |

**`src/smart-client.ts` is dead code** — a hand-rolled SMART discovery/PKCE/token-exchange implementation with its own in-memory `pendingAuthStates` Map, but nothing imports it (`server.ts` and `ehr-connect.ts` use the `fhirclient` library instead). Don't assume changes there affect runtime behavior; the live OAuth flow lives in `ehr-connect.ts`.

### Persistence: Medplum, not local SQLite

All application state (family members, provider OAuth connections, synced records) is stored as FHIR resources in a Medplum server reached via `MEDPLUM_BASE_URL` — there is no local database file and no `src/store.ts`. `data/family_health.db*` files that may exist in this directory are leftover from an earlier architecture and are unused by the current code (they're gitignored). `MEDPLUM_CLIENT_ID`/`MEDPLUM_CLIENT_SECRET` are OAuth client-credentials for a Client Application registered in Medplum admin. See `../fhir-server` for the self-hosted Medplum deployment this app talks to in production.

Everything is keyed off two Medplum-side conventions (both in `src/medplum-client.ts`):
- A `Patient` identifier on system `https://familyhealthhub.local/members` whose value is the local member UUID minted in `ehr-connect.ts` — this is the join key between "family member" and Medplum `Patient`.
- Each EHR connection (access/refresh token, EHR-side patient ID, expiry) is stored as a `Basic` resource tagged with system `https://familyhealthhub.local/token`, one per `{medplumPatientId}-{providerId}` pair, so re-authenticating overwrites cleanly instead of duplicating.

Synced clinical resources (Condition, Observation, MedicationRequest, etc.) are tagged with `meta.tag` on system `https://familyhealthhub.local/source` recording which provider they came from — this is what lets `DELETE /api/patients/:id/records/:resourceType/:resourceId` also disconnect the right EHR connection.

### SMART OAuth flow

`GET /connect/:providerId?member=UUID` and `GET /callback` are handled by `startConnect()` / `handleCallback()` in `src/ehr-connect.ts`, both built on the `fhirclient` npm package (not `src/smart-client.ts`, see above). `fhirclient` handles SMART discovery, PKCE, and state/CSRF validation internally, persisting that state via `express-session` (configured in `server.ts` with the default in-memory `MemoryStore` — no session store is configured). Practically this means the same failure mode as an in-memory state map: a server restart between the `/connect` redirect and the `/callback` invalidates the pending session and the callback fails.

`handleCallback()` also fetches the patient's demographics before creating anything in Medplum, so a brand-new family member is created with their real name/DOB/gender from the EHR rather than a placeholder (see `extractDemographics()`).

### API routes

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/patients` | All patients with clinical summary counts + EHR connection state |
| `GET` | `/api/patients/:id/records` | All FHIR records for a Medplum patient ID |
| `DELETE` | `/api/patients/:id/records/:resourceType/:resourceId` | Deletes one record, also disconnects its source EHR connection |
| `DELETE` | `/api/patients/:id` | Deletes patient + all records + all EHR connections (irreversible) |
| `GET` | `/connect/:providerId?member=UUID` | Start SMART OAuth flow |
| `GET` | `/callback` | OAuth callback — token exchange + FHIR sync to Medplum |
| `POST` | `/api/sync/:memberId` | Re-sync all EHR connections for a member using stored tokens |
| `GET`/`POST` | `/api/members` | Medplum-backed member list / create a new member (Patient) |
| `GET` | `/api/members/:id/data?type=` | FHIR resources for a member, optionally filtered by type |
| `GET` | `/api/members/:id/labs?loinc=CODE` | Lab result trend for a given LOINC code |

Full descriptions in [README.md](README.md#api-routes).

### Adding a new EHR provider

1. Add a `ProviderConfig` entry in `src/config.ts` with `id`, `name`, `fhir_base_url`, and `client_id`
2. Add it to the `PROVIDERS` array
3. Register your app at the vendor's developer portal; set redirect URI to `http://localhost:4000/callback` (or your configured `PORT`)
4. Set the corresponding `*_CLIENT_ID` env var

Note: Epic uses one `client_id` across all Epic hospitals; Oracle Health and MEDITECH may require per-site provisioning — see the comments in `src/config.ts`.

## Environment variables

See `.env.example` for the full template. Copy it to `.env` for local dev.

```
MEDPLUM_BASE_URL=http://localhost:8103/       # prod: https://api.fhir.uyir.tech/ (see ../fhir-server)
MEDPLUM_CLIENT_ID=
MEDPLUM_CLIENT_SECRET=
EPIC_CLIENT_ID=
ORACLE_CLIENT_ID=
MEDITECH_CLIENT_ID=
PORT=4000
REDIRECT_URI=http://localhost:4000/callback
SESSION_SECRET=
```

`DB_PATH` is set by convention in `.env.example` but unused by the current code (no local database — see Persistence above).

## Deployment

Dockerized like `ai-pulse-app`: `Dockerfile` (`node:22-alpine` — required for the global `WebSocket` that `@medplum/core` expects at import time; `node:20-alpine` fails at boot) runs `npm ci` then `npm start` (`tsx src/server.ts` directly; there's no `tsc` build step in the image since `npm run build` currently fails on pre-existing type errors in `src/config.ts` — `EPIC_CLIENT_ID`/`ORACLE_CLIENT_ID` are `string | undefined` but `ProviderConfig.client_id` is typed `string`).

### CI/CD

Push to `main` → GitHub Actions (`.github/workflows/deploy.yml`) builds & pushes a Docker image to `ghcr.io/rahim86/family-health-app` (tagged `latest` + short SHA) in a `build-and-push` job, then a `deploy` job — scoped to the `prod` GitHub Environment — SSHs into the VPS to pull the new image and restart the container. Health-checked via `GET /health`.

Config is split across two sources:
- **VPS connection details** (`VPS_HOST`, `VPS_USER`, `VPS_PORT`, `VPS_SSH_PRIVATE_KEY`) live in GitHub Secrets/Variables on the `prod` Environment, same as `ai-pulse-app`.
- **App/Medplum/EHR config** lives in `.github/values.yml`, committed at the repo root's `.github/` directory. The `deploy` job installs `yq` and extracts every field from it into step outputs, which become the container's env vars — including `app.port`, which is the actual production listen port (independent of the local-dev default above and of the Dockerfile's `EXPOSE 3000`).

**`.github/values.yml` contains real secrets in plaintext** (`medplum.client_secret`, `app.session_secret`) — this repo must stay private, and every value in it should be rotated if that ever changes.

### `prod` GitHub Environment (repo Settings → Environments → prod)

Secrets: `VPS_HOST`, `VPS_SSH_PRIVATE_KEY`, `VPS_PORT` (optional, defaults to 22).

Variables: `VPS_USER`.
