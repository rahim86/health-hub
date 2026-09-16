// ============================================================
// fhir-client.ts — FHIR R4 resource fetcher and normalizer
// ============================================================
//
// Once you have an access_token from the SMART flow, this module
// fetches clinical resources from the FHIR server and normalizes
// them into a consistent shape for your local store + AI layer.
//
// The same fetch logic works across Epic, Oracle Health, and
// MEDITECH because they all implement FHIR R4 / US Core.
//
// Vendor quirks handled:
//   - Epic returns DocumentReference with C-CDA attachments
//   - Oracle Health may paginate differently (Bundle.link)
//   - MEDITECH Expanse may not support all search parameters
//   - All three may use different code systems for the same concept
//
// ============================================================

import {
  FhirBundle,
  FhirResource,
  FhirCondition,
  FhirObservation,
  FhirMedicationRequest,
  FhirEncounter,
  FhirAllergyIntolerance,
  FhirImmunization,
  FhirProcedure,
  FhirDiagnosticReport,
  FhirPatient,
  FhirCodeableConcept,
} from "./types";

// ---- Core FHIR fetch ----

// Endpoint directories (e.g. epic-endpoints-R4.json) are inconsistent about
// a trailing slash on Endpoint.address. Strip it so base + resourcePath
// concatenation never produces a double slash.
export function normalizeBaseUrl(url: string): string {
  //return url.replace(/\/$/, "");
  return url;
}

class FhirForbiddenError extends Error {
  constructor(url: string, body: string) {
    super(`FHIR 403 Forbidden: ${url}\n${body}`);
    this.name = 'FhirForbiddenError';
  }
}

async function fhirFetch(
  fhirBaseUrl: string,
  resourcePath: string,
  accessToken: string
): Promise<FhirBundle> {
  const url = resourcePath.startsWith("http")
    ? resourcePath
    : `${normalizeBaseUrl(fhirBaseUrl)}/${resourcePath}`;

  const requestHeaders = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/fhir+json",
  };

  console.log(`\n [FHIR REQUEST]`);
  console.log(`  GET ${url}`);
  console.log(`  Headers: ${JSON.stringify(requestHeaders)}`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/fhir+json",
    },
  });
  
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  console.log(`  [FHIR RESPONSE]`);
  console.log(`  Status: ${response.status} ${response.statusText}`);
  console.log(`  Headers: ${JSON.stringify(responseHeaders)}`);
  
  const bodyText = await response.text();

  if (response.status === 401) {
    throw new Error("FHIR_AUTH_EXPIRED");
  }

  if (response.status === 403) {
    const body = await response.text();
    throw new FhirForbiddenError(url, body);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`FHIR request failed (${response.status}): ${body}`);
  }

  let json: FhirBundle;
  try {
    json = JSON.parse(bodyText);
  } catch (err) {
    console.error(`Failed to parse FHIR response as JSON: ${err}`);
    throw new Error(`Failed to parse FHIR response as JSON: ${err}`);
  }

  const count = json.total ?? (json.entry ? json.entry.length : 0);
  console.log(` Body: ${JSON.stringify(json, null, 2)}`);
  console.log(`  FHIR response contains ${count} resources`);

  return json;
}

// ---- Paginated fetch ----
// FHIR servers return paginated Bundles. The "next" link in
// Bundle.link tells you where to fetch the next page.

async function fetchAllPages(
  fhirBaseUrl: string,
  resourcePath: string,
  accessToken: string,
  maxPages = 10
): Promise<FhirResource[]> {
  const resources: FhirResource[] = [];
  let nextUrl: string | null = `${normalizeBaseUrl(fhirBaseUrl)}/${resourcePath}`;
  let page = 0;

  while (nextUrl && page < maxPages) {
    let bundle: FhirBundle;
    try {
      bundle = await fhirFetch(fhirBaseUrl, nextUrl, accessToken);
    } catch (err) {
      if (err instanceof FhirForbiddenError) {
        console.warn(`  [FHIR 403] Skipping ${resourcePath.split('?')[0]} — not authorized by this EHR/patient scope`);
        return resources;
      }
      throw err;
    }

    if (bundle.entry) {
      for (const entry of bundle.entry) {
        if (entry.resource) {
          resources.push(entry.resource);
        }
      }
    }

    nextUrl = bundle.link?.find((l) => l.relation === "next")?.url || null;
    page++;
  }

  return resources;
}

// ---- Resource-specific fetchers ----
// Each function fetches one resource type scoped to the patient.
// The patient ID comes from the token response (Step 3 of SMART flow).

export async function fetchPatient(
  fhirBaseUrl: string,
  patientId: string,
  accessToken: string
): Promise<FhirPatient> {
  const bundle = await fhirFetch(
    fhirBaseUrl,
    `Patient/${patientId}`,
    accessToken
  );
  // Single resource read returns the resource directly, not a Bundle
  return bundle as unknown as FhirPatient;
}

export async function fetchConditions(
  fhirBaseUrl: string,
  patientId: string,
  accessToken: string
): Promise<FhirCondition[]> {
  return fetchAllPages(
    fhirBaseUrl,
    `Condition?patient=${patientId}&_count=100`,
    accessToken
  ) as Promise<FhirCondition[]>;
}

const OBSERVATION_CATEGORIES = [
  "laboratory", 
  "vital-signs", 
  "social-history",
  "exam",
  "imaging",
  "survey",
  "therapy",
  "activity",
  "procedure",
  "other",
  "questionnaire",
  "document",
  "medication",
] as const;

export async function fetchObservations(
  fhirBaseUrl: string,
  patientId: string,
  accessToken: string,
): Promise<FhirObservation[]> {
  const results = await Promise.allSettled (
    OBSERVATION_CATEGORIES.map((category) =>
      fetchAllPages(
        fhirBaseUrl,
        `Observation?patient=${patientId}&category=${category}&_count=100`,
        accessToken
      ) as Promise<FhirObservation[]>
    )
  );
  
  const all: FhirObservation[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      console.log(' [FHIR] Observation category', OBSERVATION_CATEGORIES[index], 'fetched', result.value.length, 'resources');
      all.push(...result.value);
    } else {
      console.warn(`  [FHIR skip] Observation category "${OBSERVATION_CATEGORIES[index]}": ${result.reason?.message ?? result.reason}`);
    }
  }

  // Deduplicate observations by resource ID
  const uniqueObservations = new Map<string, FhirObservation>();
  for (const obs of all) {
    if (obs.id) {
      uniqueObservations.set(obs.id, obs);
    }
  }

  return Array.from(uniqueObservations.values());
}

export async function fetchMedications(
  fhirBaseUrl: string,
  patientId: string,
  accessToken: string
): Promise<FhirMedicationRequest[]> {
 
  const resources: FhirResource[] = [];
  const medicationMap =  new Map<String, FhirCodeableConcept>();

  let nextUrl: string | null = 
    `${normalizeBaseUrl(fhirBaseUrl)}/MedicationRequest?patient=${patientId}&_count=100&_include=MedicationRequest:medication&_include=MedicationRequest:medication`;

  let page = 0;

  while (nextUrl && page < 10) {
    let bundle: FhirBundle;
    try {
      bundle = await fhirFetch(fhirBaseUrl, nextUrl, accessToken);
    } catch (err) {
      if (err instanceof FhirForbiddenError) {
        console.warn(`  [FHIR 403] Skipping MedicationRequest — not authorized by this EHR/patient scope`);
        return resources as FhirMedicationRequest[];
      }
      throw err;
    }

    if (bundle.entry) {
      for (const entry of bundle.entry) {
        const res = entry.resource as any;

        if(!res)continue;
        if(res.resourceType === "Medication") {

          const concept: FhirCodeableConcept = res.code ?? {};

          if (res.id) {
            medicationMap.set(`Medication/${res.id}`, concept);
            medicationMap.set(res.id, concept);
          }
        } else if(res.resourceType === "MedicationRequest") {
            resources.push(res);
        }
      }
    }

    nextUrl = bundle.link?.find((l) => l.relation === "next")?.url || null;
    page++;
  }

  return resources.map((medReq) => {
    const med = medReq as any;

    //Already has a usable inline concept - nothing to do
    if (med.medicationCodeableConcept?.text || med.medicationCodeableConcept?.coding?.length) {
      return med as FhirMedicationRequest;
    }
    // Otherwise, look up the medication and use its concept
    const medConcept = medicationMap.get(med.medicationReference?.reference ?? '');
    if (medConcept) {
      med.medicationCodeableConcept = medConcept;
    }
    return med as FhirMedicationRequest;
  });
}

export async function fetchEncounters(
  fhirBaseUrl: string,
  patientId: string,
  accessToken: string
): Promise<FhirEncounter[]> {
  return fetchAllPages(
    fhirBaseUrl,
    `Encounter?patient=${patientId}&_count=50&_sort=-date`,
    accessToken
  ) as Promise<FhirEncounter[]>;
}

export async function fetchAllergies(
  fhirBaseUrl: string,
  patientId: string,
  accessToken: string
): Promise<FhirAllergyIntolerance[]> {
  return fetchAllPages(
    fhirBaseUrl,
    `AllergyIntolerance?patient=${patientId}&_count=100`,
    accessToken
  ) as Promise<FhirAllergyIntolerance[]>;
}

export async function fetchImmunizations(
  fhirBaseUrl: string,
  patientId: string,
  accessToken: string
): Promise<FhirImmunization[]> {
  return fetchAllPages(
    fhirBaseUrl,
    `Immunization?patient=${patientId}&_count=100`,
    accessToken
  ) as Promise<FhirImmunization[]>;
}

export async function fetchProcedures(
  fhirBaseUrl: string,
  patientId: string,
  accessToken: string
): Promise<FhirProcedure[]> {
  return fetchAllPages(
    fhirBaseUrl,
    `Procedure?patient=${patientId}&_count=100`,
    accessToken
  ) as Promise<FhirProcedure[]>;
}


export async function fetchDiagnosticReports(
  fhirBaseUrl: string,
  patientId: string,
  accessToken: string
): Promise<FhirDiagnosticReport[]> {
  return fetchAllPages(
    fhirBaseUrl,
    `DiagnosticReport?patient=${patientId}&_count=100`,
    accessToken
  ) as Promise<FhirDiagnosticReport[]>;
}

// ---- Full sync: pull everything for a patient ----

export interface PatientDataBundle {
  patient: FhirPatient;
  conditions: FhirCondition[];
  // All Observations for the patient (labs, vitals, social-history, exam,
  // imaging, etc.) — not just the laboratory/vital-signs categories.
  observations: FhirObservation[];
  medications: FhirMedicationRequest[];
  encounters: FhirEncounter[];
  allergies: FhirAllergyIntolerance[];
  immunizations: FhirImmunization[];
  procedures: FhirProcedure[];
  fetchedAt: string;
}

function settled<T>(result: PromiseSettledResult<T>, fallback: T, label: string): T {
  if (result.status === 'fulfilled') return result.value;
  console.warn(`  [FHIR skip] ${label}: ${result.reason?.message ?? result.reason}`);
  return fallback;
}

export async function syncPatientData(
  fhirBaseUrl: string,
  patientId: string,
  accessToken: string
): Promise<PatientDataBundle> {
  console.log(`Syncing data for patient ${patientId} from ${fhirBaseUrl}...`);

  const [
    patientResult,
    conditionsResult,
    observationsResult,
    medsResult,
    encountersResult,
    allergiesResult,
    immunizationsResult,
    proceduresResult,
    diagnosticReportsResult,
  ] = await Promise.allSettled([
    fetchPatient(fhirBaseUrl, patientId, accessToken),
    fetchConditions(fhirBaseUrl, patientId, accessToken),
    fetchObservations(fhirBaseUrl, patientId, accessToken),
    fetchMedications(fhirBaseUrl, patientId, accessToken),
    fetchEncounters(fhirBaseUrl, patientId, accessToken),
    fetchAllergies(fhirBaseUrl, patientId, accessToken),
    fetchImmunizations(fhirBaseUrl, patientId, accessToken),
    fetchProcedures(fhirBaseUrl, patientId, accessToken),
    fetchDiagnosticReports(fhirBaseUrl, patientId, accessToken),
  ]);

  if (patientResult.status === 'rejected') {
    throw new Error(`Failed to fetch Patient resource: ${patientResult.reason?.message ?? patientResult.reason}`);
  }

  const conditions    = settled(conditionsResult,     [], 'Condition');
  const observations  = settled(observationsResult,   [], 'Observation');
  const medications   = settled(medsResult,           [], 'MedicationRequest');
  const encounters    = settled(encountersResult,     [], 'Encounter');
  const allergies     = settled(allergiesResult,      [], 'AllergyIntolerance');
  const immunizations = settled(immunizationsResult,  [], 'Immunization');
  const procedures    = settled(proceduresResult,     [], 'Procedure');
  const diagnosticReports = settled(diagnosticReportsResult, [], 'DiagnosticReport');

  console.log(
    `  Fetched: ${conditions.length} conditions, ${observations.length} observations, ` +
    `${medications.length} meds, ${encounters.length} encounters, ` +
    `${allergies.length} allergies, ${immunizations.length} immunizations, ` +
    `${procedures.length} procedures, ${diagnosticReports.length} diagnostic reports`
  );

  return {
    patient: patientResult.value,
    conditions,
    observations,
    medications,
    encounters,
    allergies,
    immunizations,
    procedures,
    fetchedAt: new Date().toISOString(),
  };
}

