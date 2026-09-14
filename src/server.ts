import 'dotenv/config'; // load .env before any other imports read process.env

// ============================================================
// server.ts — Express server
// ============================================================
//
// Routes:
//   GET  /                     → Dashboard (inline HTML)
//   GET  /api/members          → List Medplum patients + record counts
//   POST /api/members          → Add a family member (Medplum Patient)
//   GET  /api/members/:id/data → FHIR resources from Medplum
//   GET  /api/members/:id/labs → Lab trends from Medplum (LOINC filter)
//   GET  /connect/:providerId  → Start SMART launch (fhirclient → Epic/Oracle)
//   GET  /callback             → OAuth callback (fhirclient token exchange)
//   POST /api/sync/:memberId   → Re-sync all EHR connections → Medplum
//   GET  /api/providers        → List configured EHR providers
//   GET  /api/epic-endpoints   → Epic hospital FHIR endpoint directory (for the hospital picker)
//   GET  /api/patients         → All Medplum patients with clinical summaries
//   GET  /api/patients/:id/records → FHIR records for a Medplum patient
//   DELETE /api/patients/:id/records/:resourceType/:resourceId → Delete a
//                              record and disconnect its source EHR connection
//   DELETE /api/patients/:id  → Delete a patient: all records, all EHR
//                              connections, and the Patient resource itself
//
// Data flow after OAuth:
//   /callback → fhirclient → EHR tokens → Medplum (Basic resource)
//                                       → Medplum (FHIR resources + Patient)
// ============================================================

import express from "express";
import session from "express-session";
import { v4 as uuidv4 } from "uuid";
import { APP_CONFIG, PROVIDERS } from "./config";
import { startConnect, handleCallback } from "./ehr-connect";
import { syncPatientData } from "./fhir-client";
import { EPIC_ENDPOINTS } from "./epic-endpoints";
import {
  initMedplum,
  getOrCreateMedplumPatient,
  getMedplumPatientId,
  getMedplumSummary,
  getMedplumRecords,
  getMedplumResource,
  deleteMedplumResource,
  deleteMedplumPatient,
  getMedplumLabTrends,
  syncResourcesToMedplum,
  listMedplumPatients,
  getEhrConnectionsForPatient,
  disconnectEhrConnection,
  SOURCE_TAG_SYSTEM,
} from "./medplum-client";

const app = express();
app.use(express.json());

// express-session is required by fhirclient to persist PKCE state between
// the /connect redirect and the /callback. Must come before OAuth routes.
app.use(
  session({
    secret: APP_CONFIG.session_secret,
    resave: false,
    saveUninitialized: false,
  })
);

// ---- Health check ----

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ---- Dashboard ----

app.get("/", (_req, res) => {
  res.send(DASHBOARD_HTML);
});

// ---- Family Member APIs ----

app.get("/api/members", async (_req, res) => {
  try {
    const patients = await listMedplumPatients();
    const result = await Promise.all(
      patients.map(async (p: any) => {
        const summary = await getMedplumSummary(p.id);
        return { ...p, summary };
      })
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/members", async (req, res) => {
  try {
    const { name, date_of_birth } = req.body;
    const memberId = uuidv4();
    const medplumPatientId = await getOrCreateMedplumPatient(memberId, {
      name,
      birthDate: date_of_birth,
    });
    res.json({ id: memberId, medplumPatientId, name, date_of_birth });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/members/:id/data", async (req, res) => {
  try {
    const medplumPatientId = await getMedplumPatientId(req.params.id);
    if (!medplumPatientId) return res.json([]);
    const records = await getMedplumRecords(
      medplumPatientId,
      req.query.type as string | undefined
    );
    res.json(records);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/members/:id/labs", async (req, res) => {
  try {
    const { loinc } = req.query;
    if (!loinc) return res.status(400).json({ error: "loinc query param required" });
    const medplumPatientId = await getMedplumPatientId(req.params.id);
    if (!medplumPatientId) return res.json([]);
    const trends = await getMedplumLabTrends(medplumPatientId, loinc as string);
    res.json(trends);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- SMART Launch ----
// GET /connect/:providerId?member=MEMBER_UUID
// fhirclient discovers the EHR's OAuth endpoints and redirects the browser
// to the EHR login page. The registered callback URL at Epic / Oracle must be:
//   http://localhost:PORT/callback  (i.e. this Express server, not Medplum)

app.get("/connect/:providerId", async (req, res) => {
  try {
    await startConnect(req, res);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /callback?code=AUTH_CODE&state=STATE
// Epic / Oracle redirects here after the patient authenticates.
// fhirclient validates state + PKCE, exchanges the code for tokens,
// then we fetch FHIR resources and write them to Medplum.

app.get("/callback", async (req, res) => {
  try {
    await handleCallback(req, res);
  } catch (err: any) {
    console.error("OAuth callback error:", err);
    res.status(500).send(
      `<h2>Connection failed</h2><p>${err.message}</p><a href="/">Back</a>`
    );
  }
});

app.post("/api/sync/:memberId", async (req, res) => {
  try {
    const memberId = req.params.memberId;
    const medplumPatientId = await getMedplumPatientId(memberId);
    if (!medplumPatientId) return res.status(404).json({ error: "Member not found in Medplum" });

    const connections = await getEhrConnectionsForPatient(medplumPatientId);

    let totalRecords = 0;
    for (const conn of connections) {
      const data = await syncPatientData(
        conn.fhir_base_url,
        conn.ehr_patient_id,
        conn.access_token
      );
      const allResources = [
        ...data.conditions, ...data.observations,
        ...data.medications, ...data.encounters, ...data.allergies,
        ...data.immunizations, ...data.procedures,
      ];
      totalRecords += await syncResourcesToMedplum(
        allResources,
        medplumPatientId,
        conn.provider_id
      );
    }
    res.json({ synced: totalRecords });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Available providers ----

app.get("/api/providers", (_req, res) => {
  res.json(
    PROVIDERS.map((p) => ({ id: p.id, name: p.name, fhir_base_url: p.fhir_base_url }))
  );
});

// Epic's per-hospital FHIR endpoint directory (epic-endpoints-R4.json), used
// to populate the hospital picker next to "Connect via Epic" on the dashboard.
app.get("/api/epic-endpoints", (_req, res) => {
  res.json(EPIC_ENDPOINTS);
});

// ---- Medplum patient roster ----
// Returns all Patient resources in Medplum with clinical summary counts.

const MEMBER_SYSTEM = 'https://familyhealthhub.local/members';

app.get("/api/patients", async (_req, res) => {
  try {
    const patients = await listMedplumPatients();
    const enriched = await Promise.all(
      patients.map(async (p: any) => {
        const summary = await getMedplumSummary(p.id);
        const memberIdent = (p.identifier ?? []).find((i: any) => i.system === MEMBER_SYSTEM);
        const memberId: string | undefined = memberIdent?.value;
        const connections = await getEhrConnectionsForPatient(p.id);
        return { ...p, summary, memberId, connections };
      })
    );
    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Returns all FHIR clinical records for a Medplum patient, grouped by resource type.

app.get("/api/patients/:id/records", async (req, res) => {
  try {
    const records = await getMedplumRecords(req.params.id, req.query.type as string | undefined);
    res.json(records);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Deletes a single FHIR record from Medplum and, since the record identifies
// the EHR it was synced from (meta.tag), also disconnects that provider's
// connection so it isn't pulled back in on the next sync.
app.delete("/api/patients/:id/records/:resourceType/:resourceId", async (req, res) => {
  try {
    const { id: medplumPatientId, resourceType, resourceId } = req.params;

    const resource = await getMedplumResource(resourceType, resourceId);
    const providerId: string | undefined = resource?.meta?.tag?.find(
      (t: any) => t.system === SOURCE_TAG_SYSTEM
    )?.code;

    await deleteMedplumResource(resourceType, resourceId);

    if (providerId) {
      await disconnectEhrConnection(medplumPatientId, providerId);
    }

    res.json({ deleted: true, disconnectedProvider: providerId ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Deletes a patient entirely: every clinical record, every EHR connection,
// and the Patient resource itself. Irreversible.
app.delete("/api/patients/:id", async (req, res) => {
  try {
    await deleteMedplumPatient(req.params.id);
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Boot ----

initMedplum()
  .then(() => {
    app.listen(APP_CONFIG.port, () => {
      console.log(`\n  Family Health Hub running at http://localhost:${APP_CONFIG.port}`);
      console.log(`  Providers : ${PROVIDERS.map((p) => p.name).join(", ")}`);
      console.log(`  Medplum   : ${process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103/"}`);
      console.log(`  OAuth callback (register this with Epic / Oracle):`);
      console.log(`    ${APP_CONFIG.redirect_uri}\n`);
    });
  })
  .catch((err) => {
    console.error("\n  Failed to connect to Medplum:", err.message);
    console.error("  Create a Client Application in Medplum admin (localhost:3000)");
    console.error("  then set MEDPLUM_CLIENT_ID and MEDPLUM_CLIENT_SECRET in .env\n");
    process.exit(1);
  });

// ---- Dashboard HTML ----

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Family Health Hub</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8f7f4;
           color: #2c2c2a; line-height: 1.6; padding: 32px; max-width: 1000px; margin: 0 auto; }
    h1 { font-size: 22px; font-weight: 500; margin-bottom: 4px; }
    .subtitle { font-size: 13px; color: #888780; margin-bottom: 28px; }
    .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
    .toolbar input { padding: 8px 12px; border: 1px solid #d3d1c7; border-radius: 8px;
                     font-size: 14px; flex: 1; }
    .card { background: #fff; border: 1px solid #e8e7e3; border-radius: 12px;
            padding: 20px 24px; margin-bottom: 14px; }
    .card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .card-header h2 { font-size: 16px; font-weight: 500; }
    .meta { font-size: 12px; color: #888780; margin-top: 2px; }
    .tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0 0; }
    .tab { font-size: 13px; color: #5f5e5a; background: #f8f7f4; border-radius: 8px;
           padding: 6px 14px; cursor: pointer; border: 1px solid transparent;
           user-select: none; transition: background 0.15s; }
    .tab:hover { background: #eeedfe; color: #534ab7; }
    .tab.active { background: #534ab7; color: #fff; border-color: #534ab7; }
    .tab strong { display: block; font-size: 18px; line-height: 1.2; }
    .tab.active strong { color: #fff; }
    .btn { display: inline-block; padding: 7px 14px; font-size: 13px;
           border: 1px solid #d3d1c7; border-radius: 8px; background: #fff;
           color: #2c2c2a; cursor: pointer; text-decoration: none; white-space: nowrap; }
    .btn:hover { background: #f1efe8; }
    .btn-primary { background: #534ab7; color: #fff; border-color: #534ab7; }
    .btn-primary:hover { background: #3c3489; }
    .btn-sm { padding: 5px 10px; font-size: 12px; }
    .btn-danger { color: #b3261e; border-color: #f2b8b5; }
    .btn-danger:hover { background: #fdecea; }
    .empty { text-align: center; padding: 48px; color: #888780; }
    .records-panel { display: none; margin-top: 16px; border-top: 1px solid #f0ede6; padding-top: 16px; }
    .records-panel.open { display: block; }
    .records-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .records-table th { text-align: left; font-weight: 600; color: #534ab7; padding: 6px 10px;
                        border-bottom: 1px solid #eeedfe; }
    .records-table td { padding: 7px 10px; border-bottom: 1px solid #f3f2ee; vertical-align: top; }
    .records-table tr:last-child td { border-bottom: none; }
    .records-table tr:hover td { background: #faf9f7; }
    .rdate { font-size: 11px; color: #888780; white-space: nowrap; }
    .rstatus { font-size: 11px; color: #888780; }
    .loading-text { font-size: 13px; color: #888780; padding: 8px 0; }
    .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px;
             background: #eeedfe; color: #534ab7; margin-left: 8px; vertical-align: middle; }
    .ehr-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
    .banner { background: #e8f5e9; color: #2e7d32; border: 1px solid #c8e6c9; border-radius: 10px;
              padding: 12px 16px; font-size: 13px; margin-bottom: 14px; }
    .connect-card .card-header h2 { margin-bottom: 2px; }
  </style>
</head>
<body>
  <h1>Family Health Hub</h1>
  <p class="subtitle">Patients pulled from Medplum FHIR server &bull; EHR: Epic / Oracle Health via SMART on FHIR</p>

  <div id="banner"></div>

  <div class="card connect-card">
    <div class="card-header">
      <div>
        <h2>Connect a New Patient</h2>
        <div class="meta">Sign in at the EHR&rsquo;s patient portal &mdash; their demographics and records are pulled into Medplum automatically</div>
      </div>
    </div>
    <div class="ehr-actions" id="connect-providers-list">
      <span class="meta">Loading providers…</span>
    </div>
  </div>

  <div class="toolbar">
    <input type="text" id="search" placeholder="Search patients by name…" oninput="filterPatients()">
    <button class="btn btn-primary" onclick="load()">&#8635; Refresh</button>
  </div>

  <div id="patients"><div class="empty">Loading patients from Medplum…</div></div>

  <script>
    let allPatients = [];
    let providers = [];
    let epicEndpoints = [];
    const recordsCache = {};

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    (function showConnectedBanner() {
      const params = new URLSearchParams(window.location.search);
      if (params.get('connected') === 'true') {
        document.getElementById('banner').innerHTML =
          '<div class="banner">&#10003; Connected successfully &mdash; patient synced to Medplum.</div>';
        window.history.replaceState({}, '', window.location.pathname);
      }
    })();

    function renderConnectProviders() {
      const el = document.getElementById('connect-providers-list');
      if (!providers.length) {
        el.innerHTML = '<span class="meta">No EHR providers configured.</span>';
        return;
      }

      const sandboxRow = providers.map(pv =>
        '<a class="btn btn-primary" href="/connect/' + pv.id + '">Connect via ' + pv.name + '</a>'
      ).join('');

      const epicProvider = providers.find(pv => pv.id.indexOf('epic') === 0);
      let pickerRow = '';
      if (epicProvider && epicEndpoints.length) {
        const options = epicEndpoints.map(ep =>
          '<option value="' + escapeHtml(ep.address) + '">' + escapeHtml(ep.name) + '</option>'
        ).join('');
        pickerRow = '<div style="display:flex;gap:8px;align-items:center;width:100%;margin-top:10px">'
          + '<select id="epic-endpoint-select" class="btn btn-sm">' + options + '</select>'
          + '<button class="btn btn-primary" onclick="connectEpic(\\'' + epicProvider.id + '\\')">Connect via Epic</button>'
          + '</div>';
      }

      el.innerHTML = sandboxRow + pickerRow;
    }

    function connectEpic(providerId) {
      const sel = document.getElementById('epic-endpoint-select');
      window.location.href = '/connect/' + providerId + '?fhir_base_url=' + encodeURIComponent(sel.value);
    }

    const TABS = [
      { label: 'Conditions',   type: 'Condition',          key: 'conditions'   },
      { label: 'Medications',  type: 'MedicationRequest',  key: 'medications'  },
      { label: 'Labs',         type: 'Observation',        key: 'observations' },
      { label: 'Encounters',   type: 'Encounter',          key: 'encounters'   },
      { label: 'Allergies',    type: 'AllergyIntolerance', key: 'allergies'    },
      { label: 'Vaccines',     type: 'Immunization',       key: 'immunizations'},
    ];

    async function load() {
      const el = document.getElementById('patients');
      el.innerHTML = '<div class="empty">Loading patients from Medplum…</div>';
      try {
        [allPatients, providers, epicEndpoints] = await Promise.all([
          fetch('/api/patients').then(r => r.json()),
          fetch('/api/providers').then(r => r.json()),
          fetch('/api/epic-endpoints').then(r => r.json()),
        ]);
        renderConnectProviders();
        render(allPatients);
      } catch(e) {
        el.innerHTML = '<div class="empty">Failed to load: ' + e.message + '</div>';
      }
    }

    function filterPatients() {
      const q = document.getElementById('search').value.trim().toLowerCase();
      if (!q) return render(allPatients);
      render(allPatients.filter(p => patientName(p).toLowerCase().includes(q)));
    }

    function patientName(p) {
      if (!p.name || !p.name.length) return 'Unknown';
      const n = p.name[0];
      if (n.text) return n.text;
      return [].concat(n.given || []).concat(n.family ? [n.family] : []).join(' ') || 'Unknown';
    }

    function patientMeta(p) {
      const parts = [];
      if (p.birthDate) parts.push('DOB: ' + p.birthDate);
      if (p.gender) parts.push(p.gender.charAt(0).toUpperCase() + p.gender.slice(1));
      const ids = (p.identifier || []).filter(i => i.system && !i.system.includes('familyhealthhub'));
      if (ids.length) parts.push('ID: ' + ids[0].value + (ids[0].system ? ' (' + ids[0].system.split('/').pop() + ')' : ''));
      return parts.join(' &bull; ');
    }

    function render(patients) {
      const el = document.getElementById('patients');
      if (!patients.length) {
        el.innerHTML = '<div class="empty">No patients found in Medplum.</div>';
        return;
      }
      el.innerHTML = patients.map(p => {
        const s = p.summary || {};
        const total = (s.conditions||0)+(s.medications||0)+(s.observations||0)+(s.encounters||0)+(s.allergies||0)+(s.immunizations||0);
        const connectedIds = (p.connections || []).map(c => c.provider_id);
        const available = p.memberId ? providers.filter(pv => !connectedIds.includes(pv.id) && pv.id.indexOf('oracle') !== 0) : [];
        const connected = providers.filter(pv => connectedIds.includes(pv.id));
        const tabsHtml = TABS.map(t =>
          '<div class="tab" id="tab-' + p.id + '-' + t.type + '" onclick="selectTab(\\'' + p.id + '\\',\\'' + t.type + '\\')">'
          + '<strong>' + (s[t.key] || 0) + '</strong>' + t.label
          + '</div>'
        ).join('');
        return '<div class="card" id="card-' + p.id + '">'
          + '<div class="card-header">'
          + '<div>'
          + '<h2>' + patientName(p) + (total > 0 ? '<span class="badge">' + total + ' records</span>' : '') + '</h2>'
          + '<div class="meta">' + (patientMeta(p) || '&nbsp;') + '</div>'
          + (connected.length ? '<div class="meta" style="margin-top:4px">Connected: ' + connected.map(pv => '<span class="badge" style="background:#e8f5e9;color:#2e7d32">' + pv.name + '</span>').join(' ') + '</div>' : '')
          + '</div>'
          + '<div style="display:flex;gap:8px;flex-shrink:0;align-items:flex-start">'
          + (p.memberId && connected.length ? '<button class="btn btn-sm" onclick="syncPatient(\\'' + p.memberId + '\\',this)">&#8635; Sync</button>' : '')
          + '<button class="btn btn-sm btn-danger" onclick="deletePatient(\\'' + p.id + '\\',this)">Delete Patient</button>'
          + '</div>'
          + '</div>'
          + (available.length ? '<div class="ehr-actions">'
              + available.map(pv => '<a class="btn btn-sm btn-primary" href="/connect/' + pv.id + '?member=' + p.memberId + '">Connect ' + pv.name + '</a>').join('')
              + '</div>' : '')
          + '<div class="tabs">' + tabsHtml + '</div>'
          + '<div class="records-panel" id="records-' + p.id + '"></div>'
          + '</div>';
      }).join('');
    }

    async function selectTab(patientId, resourceType) {
      const panel = document.getElementById('records-' + patientId);
      const activeTab = document.getElementById('tab-' + patientId + '-' + resourceType);

      // Clicking the active tab again collapses the panel
      if (activeTab.classList.contains('active')) {
        activeTab.classList.remove('active');
        panel.classList.remove('open');
        return;
      }

      // Deactivate all tabs for this patient
      TABS.forEach(t => {
        const el = document.getElementById('tab-' + patientId + '-' + t.type);
        if (el) el.classList.remove('active');
      });
      activeTab.classList.add('active');

      panel.classList.add('open');
      panel.innerHTML = '<div class="loading-text">Loading ' + resourceType + '…</div>';

      const cacheKey = patientId + '|' + resourceType;
      if (!recordsCache[cacheKey]) {
        try {
          const res = await fetch('/api/patients/' + patientId + '/records?type=' + resourceType);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || res.statusText);
          if (!Array.isArray(data)) throw new Error('Unexpected response: ' + JSON.stringify(data));
          recordsCache[cacheKey] = data;
        } catch(e) {
          panel.innerHTML = '<div class="loading-text">Failed to load: ' + e.message + '</div>';
          return;
        }
      }

      panel.innerHTML = renderRecords(recordsCache[cacheKey], resourceType, patientId);
    }

    function renderRecords(records, resourceType, patientId) {
      if (!records.length) return '<div class="loading-text">No ' + resourceType + ' records found.</div>';
      const rows = records.map(r =>
        '<tr id="row-' + r.id + '"><td>' + resourceLabel(r) + '</td>'
        + '<td class="rstatus">' + (resourceStatus(r) || '') + '</td>'
        + '<td class="rdate">' + resourceDate(r) + '</td>'
        + '<td><button class="btn btn-sm btn-danger" onclick="deleteRecord(\\'' + patientId + '\\',\\'' + resourceType + '\\',\\'' + r.id + '\\',this)">Delete</button></td></tr>'
      ).join('');
      return '<table class="records-table">'
        + '<thead><tr><th>Description</th><th>Status</th><th>Date</th><th></th></tr></thead>'
        + '<tbody>' + rows + '</tbody>'
        + '</table>';
    }

    async function deleteRecord(patientId, resourceType, resourceId, btn) {
      if (!confirm('Delete this record from the FHIR server? This will also disconnect its source EHR connection.')) return;
      btn.disabled = true;
      btn.textContent = 'Deleting…';
      try {
        const res = await fetch(
          '/api/patients/' + encodeURIComponent(patientId) + '/records/'
          + encodeURIComponent(resourceType) + '/' + encodeURIComponent(resourceId),
          { method: 'DELETE' }
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);

        const cacheKey = patientId + '|' + resourceType;
        if (recordsCache[cacheKey]) {
          recordsCache[cacheKey] = recordsCache[cacheKey].filter(r => r.id !== resourceId);
        }
        const row = document.getElementById('row-' + resourceId);
        if (row) row.remove();

        if (data.disconnectedProvider) {
          alert('Record deleted and disconnected from ' + data.disconnectedProvider + '.');
          load();
        }
      } catch(e) {
        alert('Delete failed: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Delete';
      }
    }

    function resourceLabel(r) {
      if (r.resourceType === 'Condition') {
        const c = r.code?.coding?.[0];
        return r.code?.text || c?.display || c?.code || 'Unknown condition';
      }
      if (r.resourceType === 'MedicationRequest') {
        const m = r.medicationCodeableConcept;
        const dose = r.dosageInstruction?.[0]?.text;
        const name = m?.text || m?.coding?.[0]?.display || 'Unknown medication';
        return name + (dose ? '<br><span class="rstatus">' + dose + '</span>' : '');
      }
      if (r.resourceType === 'Observation') {
        const label = r.code?.text || r.code?.coding?.[0]?.display || 'Observation';
        const val = r.valueQuantity
          ? '<strong>' + r.valueQuantity.value + ' ' + (r.valueQuantity.unit || '') + '</strong>'
          : (r.valueString || r.valueCodeableConcept?.text || '');
        return label + (val ? ': ' + val : '');
      }
      if (r.resourceType === 'Encounter') {
        return r.type?.[0]?.text || r.class?.display || r.class?.code || 'Encounter';
      }
      if (r.resourceType === 'AllergyIntolerance') {
        const name = r.code?.text || r.code?.coding?.[0]?.display || 'Allergy';
        return name + (r.criticality ? ' <span class="rstatus">(' + r.criticality + ')</span>' : '');
      }
      if (r.resourceType === 'Immunization') {
        return r.vaccineCode?.text || r.vaccineCode?.coding?.[0]?.display || 'Vaccine';
      }
      if (r.resourceType === 'Procedure') {
        return r.code?.text || r.code?.coding?.[0]?.display || 'Procedure';
      }
      return r.id || r.resourceType;
    }

    function resourceStatus(r) {
      return r.status || r.clinicalStatus?.coding?.[0]?.code || '';
    }

    function resourceDate(r) {
      const raw = r.effectiveDateTime || r.recordedDate || r.authoredOn
        || r.onsetDateTime || r.occurrenceDateTime || r.performedDateTime
        || r.period?.start || r.date || '';
      if (!raw) return '—';
      try { return new Date(raw).toLocaleDateString(); } catch(_) { return raw.slice(0, 10); }
    }

    async function syncPatient(memberId, btn) {
      btn.textContent = 'Syncing…';
      btn.disabled = true;
      try {
        const res = await fetch('/api/sync/' + memberId, { method: 'POST' });
        const data = await res.json();
        alert('Synced ' + data.synced + ' records to Medplum');
      } catch(e) {
        alert('Sync failed: ' + e.message);
      }
      load();
    }

    async function deletePatient(patientId, btn) {
      const patient = allPatients.find(p => p.id === patientId);
      const name = patient ? patientName(patient) : 'this patient';
      if (!confirm('Permanently delete ' + name + ' and ALL their records, connections, and history? This cannot be undone.')) return;
      btn.disabled = true;
      btn.textContent = 'Deleting…';
      try {
        const res = await fetch('/api/patients/' + encodeURIComponent(patientId), { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        const card = document.getElementById('card-' + patientId);
        if (card) card.remove();
        allPatients = allPatients.filter(p => p.id !== patientId);
      } catch(e) {
        alert('Delete failed: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Delete Patient';
      }
    }

    load();
  </script>
</body>
</html>`;
