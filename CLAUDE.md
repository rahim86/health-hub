# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev        # tsx watch src/server.ts — auto-restart on changes (port 3000)
npm start          # production run
npm run build      # tsc compile check (outputs to dist/ per tsconfig)
npm run typecheck  # tsc --noEmit — type-check without emitting
```

There are no automated tests. Manual testing is done via the browser at `http://localhost:3000`.

## Architecture

Single-process Express 4 server written in TypeScript. No frontend framework — the dashboard is a self-contained HTML string inlined at the bottom of `src/server.ts`. The app boots by calling `initMedplum()`; if it can't authenticate to Medplum, the process exits before `app.listen()` runs (see `src/server.ts` "Boot" section) — a live, reachable Medplum server is a hard startup dependency, not an optional store.

### Data flow

```
Browser → GET /connect/:providerId?member=UUID
         → SMART discovery → OAuth2 + PKCE redirect to EHR
         → EHR redirects back to GET /callback?code=...&state=...
         → Token exchange → syncPatientData() → normalizeResources() → Medplum (FHIR store)
```

### Module responsibilities

| File | Purpose |
|------|---------|
| `src/config.ts` | `ProviderConfig[]` entries for Epic/Oracle sandbox + `APP_CONFIG` from env |
| `src/types.ts` | All TypeScript interfaces: SMART types, FHIR R4 resource shapes, `NormalizedRecord` |
| `src/smart-client.ts` | SMART App Launch v2.1: discovery, PKCE auth URL, token exchange, refresh |
| `src/fhir-client.ts` | Paginated FHIR R4 fetchers, `syncPatientData()`, `normalizeResources()` |
| `src/medplum-client.ts` | Singleton `MedplumClient` — client-credentials login (`initMedplum()`), Patient/connection/record persistence against the Medplum FHIR API |
| `src/server.ts` | Express routes + inline dashboard HTML |

### Persistence: Medplum, not local SQLite

All application state (family members, provider OAuth connections, synced records) is stored as FHIR resources in a Medplum server reached via `MEDPLUM_BASE_URL` — there is no local database file and no `src/store.ts`. `data/family_health.db*` files that may exist in this directory are leftover from an earlier architecture and are unused by the current code (they're gitignored). `MEDPLUM_CLIENT_ID`/`MEDPLUM_CLIENT_SECRET` are OAuth client-credentials for a Client Application registered in Medplum admin. See `../fhir-server` for the self-hosted Medplum deployment this app talks to in production.

### SMART OAuth flow

`pendingAuthStates` in `smart-client.ts` is an **in-memory Map** keyed on the OAuth `state` parameter. It is populated in `buildAuthorizationUrl()` and consumed (deleted) in `exchangeCodeForToken()`. A server restart between the `/connect` redirect and the `/callback` will cause the callback to fail with "Invalid or expired OAuth state."

Discovery is cached in `discoveryCache` (also in-memory). It first tries `{fhir_base_url}/.well-known/smart-configuration` and falls back to parsing the FHIR `CapabilityStatement` at `/metadata`.

### Normalization

`normalizeResources()` in `fhir-client.ts` maps each FHIR resource type to a `NormalizedRecord`. The `raw_json` field preserves the full original resource for AI input. `code_system` / `code_value` extract the first coding entry — LOINC for labs, ICD-10-CM/SNOMED for conditions, RxNorm for meds (compliance varies by EHR).

### Adding a new EHR provider

1. Add a `ProviderConfig` entry in `src/config.ts` with `id`, `name`, `fhir_base_url`, and `client_id`
2. Add it to the `PROVIDERS` array
3. Register your app at the vendor's developer portal; set redirect URI to `http://localhost:3000/callback`
4. Set the corresponding `*_CLIENT_ID` env var

## Environment variables

See `.env.example` for the full template. Copy it to `.env` for local dev.

```
MEDPLUM_BASE_URL=http://localhost:8103/       # prod: https://api.fhir.uyir.tech/ (see ../fhir-server)
MEDPLUM_CLIENT_ID=
MEDPLUM_CLIENT_SECRET=
EPIC_CLIENT_ID=
ORACLE_CLIENT_ID=
MEDITECH_CLIENT_ID=
PORT=3000
REDIRECT_URI=http://localhost:3000/callback
SESSION_SECRET=
```

`DB_PATH` is set by convention in `.env.example` but unused by the current code (no local database — see Persistence above).

## Deployment

Dockerized like `ai-pulse-app`: `Dockerfile` (`node:22-alpine` — required for the global `WebSocket` that `@medplum/core` expects at import time; `node:20-alpine` fails at boot) runs `npm ci` then `npm start` (`tsx src/server.ts` directly; there's no `tsc` build step in the image since `npm run build` currently fails on pre-existing type errors in `src/config.ts` unrelated to this task).

### CI/CD

Push to `main` → GitHub Actions (`.github/workflows/deploy.yml`) builds & pushes a Docker image to `ghcr.io/rahim86/family-health-app` (tagged `latest` + short SHA) in a `build-and-push` job, then a `deploy` job — scoped to the `prod` GitHub Environment — SSHs into the VPS to pull the new image and restart the container. Health-checked via `GET /health`.

Config is split across two sources:
- **VPS connection details** (`VPS_HOST`, `VPS_USER`, `VPS_PORT`, `VPS_SSH_PRIVATE_KEY`) live in GitHub Secrets/Variables on the `prod` Environment, same as `ai-pulse-app`.
- **App/Medplum/EHR config** lives in `.github/values.yml`, committed at the repo root's `.github/` directory. The `deploy` job installs `yq` and extracts every field from it into step outputs, which become the container's env vars.

**`.github/values.yml` contains real secrets in plaintext** (`medplum.client_secret`, `app.session_secret`) — this repo must stay private, and every value in it should be rotated if that ever changes. See the warning comment at the top of the file for the full field list; fill in every `REPLACE_ME` before the deploy workflow will succeed.

### `prod` GitHub Environment (repo Settings → Environments → prod)

Secrets: `VPS_HOST`, `VPS_SSH_PRIVATE_KEY`, `VPS_PORT` (optional, defaults to 22).

Variables: `VPS_USER`.
