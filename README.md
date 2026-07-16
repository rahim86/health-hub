# Family Health Hub

A personal family health data aggregator that connects to Epic and Oracle Health via **SMART on FHIR** standalone launch. This Express app handles the OAuth flow; all application state — family members, EHR connection tokens, and clinical FHIR data — is stored in a self-hosted **Medplum** FHIR server running in Docker. There is no local database.

## Architecture

```
Browser
  │
  ├─ GET /connect/:providerId?member=UUID
  │       └─ fhirclient → SMART discovery → redirect to EHR login
  │
  └─ GET /callback?code=...&state=...
          └─ fhirclient token exchange
                  └─ FHIR resources + EHR tokens → Medplum FHIR API (:8103)

Dashboard (http://localhost:4000)
  └─ /api/patients  ←── reads Patient + summary counts from Medplum
```

### Port map

| Service | Port | Notes |
|---------|------|-------|
| This app (Express) | **4000** | OAuth callback, dashboard, API |
| Medplum web UI | 3000 | Admin console (Docker) |
| Medplum FHIR API | 8103 | FHIR R4 REST endpoint (Docker) |

### Module responsibilities

| File | Purpose |
|------|---------|
| `src/config.ts` | `ProviderConfig[]` for Epic / Oracle sandbox + `APP_CONFIG` from env |
| `src/types.ts` | TypeScript interfaces: SMART discovery/token types, FHIR R4 resource shapes |
| `src/ehr-connect.ts` | SMART App Launch via `fhirclient`: build auth URL, exchange code for token, write results to Medplum |
| `src/fhir-client.ts` | Paginated FHIR R4 fetchers, `syncPatientData()` |
| `src/medplum-client.ts` | Singleton `MedplumClient`, all read/write helpers against Medplum FHIR API |
| `src/server.ts` | Express routes + inline dashboard HTML |

(`src/smart-client.ts` is an older, unused hand-rolled SMART/PKCE implementation — nothing imports it. The live OAuth flow runs through `src/ehr-connect.ts` and the `fhirclient` library.)

### Data model

Everything lives in Medplum:

- **`Patient`** resources for each family member, carrying an identifier on system `https://familyhealthhub.local/members` whose value is the local member UUID — the join key used to look up a member's Medplum patient.
- **`Basic`** resources (one per member/provider pair) hold each EHR connection's access/refresh token and expiry, tagged on system `https://familyhealthhub.local/token`.
- Clinical resources (Condition, Observation, MedicationRequest, Encounter, AllergyIntolerance, Immunization, Procedure) are tagged with `meta.tag` on system `https://familyhealthhub.local/source` recording which EHR they were synced from.

## Prerequisites

- Node.js 18+
- [Medplum](https://www.medplum.com/docs/self-hosting/docker-compose) running in Docker (`docker compose up -d` in your Medplum directory)

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your Medplum credentials and Epic/Oracle client IDs
npm run dev       # starts on http://localhost:4000
```

### Medplum client credentials

1. Open Medplum admin UI at `http://localhost:3000`
2. Admin → Project → Client Applications → New
3. Name it "Family Health Hub Server" — copy the generated **Client ID** and **Secret** into `.env`

## Environment variables

```
MEDPLUM_BASE_URL=http://localhost:8103/
MEDPLUM_CLIENT_ID=<from Medplum admin>
MEDPLUM_CLIENT_SECRET=<from Medplum admin>

EPIC_CLIENT_ID=<from fhir.epic.com>
ORACLE_CLIENT_ID=<from code-console.cerner.com>

PORT=4000
REDIRECT_URI=http://localhost:4000/callback
DB_PATH=./data/family_health.db
SESSION_SECRET=<random string, e.g. openssl rand -hex 32>
```

## Registering your app with EHR vendors

### Epic

1. Go to [fhir.epic.com](https://fhir.epic.com) → Build Apps → Create App
2. Select **Patient Access** (Standalone Launch)
3. Scopes: `patient/Patient.read`, `patient/Condition.read`, `patient/Observation.read`, `patient/MedicationRequest.read`, `patient/Encounter.read`, `patient/AllergyIntolerance.read`, `patient/Immunization.read`, `patient/Procedure.read`
4. Redirect URI: `http://localhost:4000/callback`
5. Copy the non-production Client ID into `.env` as `EPIC_CLIENT_ID`

### Oracle Health (Cerner)

1. Go to [code-console.cerner.com](https://code-console.cerner.com) → Register
2. Create a new app → Patient-facing → Standalone
3. Same FHIR R4 scopes as Epic
4. Redirect URI: `http://localhost:4000/callback`
5. Copy Client ID into `.env` as `ORACLE_CLIENT_ID`

## API routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/` | Dashboard (inline HTML) |
| `GET` | `/api/patients` | All patients from Medplum with clinical summary counts and EHR connection state |
| `GET` | `/api/patients/:id/records` | All FHIR records for a Medplum patient ID |
| `DELETE` | `/api/patients/:id/records/:resourceType/:resourceId` | Delete a single record and disconnect its source EHR connection |
| `DELETE` | `/api/patients/:id` | Delete a patient: all records, all EHR connections, and the Patient resource itself (irreversible) |
| `GET` | `/api/providers` | Configured EHR providers |
| `GET` | `/connect/:providerId?member=UUID` | Start SMART OAuth flow |
| `GET` | `/callback` | OAuth callback — token exchange + FHIR sync to Medplum |
| `POST` | `/api/sync/:memberId` | Re-sync all EHR connections for a member using stored tokens |
| `GET` | `/api/members` | Medplum-backed member list with summary counts |
| `POST` | `/api/members` | Create a new member (Medplum Patient) |
| `GET` | `/api/members/:id/data` | FHIR resources for a member, optionally filtered by `?type=` |
| `GET` | `/api/members/:id/labs?loinc=CODE` | Lab result trend for a given LOINC code |

## Usage

```bash
npm run dev
# Open http://localhost:4000
# Patient cards are pulled live from Medplum
# Click "Connect Epic" or "Connect Oracle Health" on any patient card to start OAuth
# After auth, FHIR data is fetched and written to Medplum automatically
# Use "Sync" to re-fetch using stored tokens
```
