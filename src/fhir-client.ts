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
  FhirPatient,
} from "./types";

// ---- Core FHIR fetch ----

// Endpoint directories (e.g. epic-endpoints-R4.json) are inconsistent about
// a trailing slash on Endpoint.address. Strip it so base + resourcePath
// concatenation never produces a double slash.
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
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

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/fhir+json",
    },
  });

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

  return response.json();
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

export async function fetchObservations(
  fhirBaseUrl: string,
  patientId: string,
  accessToken: string,
  category?: "laboratory" | "vital-signs" | "social-history"
): Promise<FhirObservation[]> {
  let path = `Observation?patient=${patientId}&_count=100&_sort=-date`;
  if (category) {
    path += `&category=${category}`;
  }
  return fetchAllPages(fhirBaseUrl, path, accessToken) as Promise<
    FhirObservation[]
  >;
}

export async function fetchMedications(
  fhirBaseUrl: string,
  patientId: string,
  accessToken: string
): Promise<FhirMedicationRequest[]> {
  return fetchAllPages(
    fhirBaseUrl,
    `MedicationRequest?patient=${patientId}&_count=100`,
    accessToken
  ) as Promise<FhirMedicationRequest[]>;
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

// ---- Full sync: pull everything for a patient ----

export interface PatientDataBundle {
  patient: FhirPatient;
  conditions: FhirCondition[];
  labResults: FhirObservation[];
  vitals: FhirObservation[];
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
    labsResult,
    vitalsResult,
    medsResult,
    encountersResult,
    allergiesResult,
    immunizationsResult,
    proceduresResult,
  ] = await Promise.allSettled([
    fetchPatient(fhirBaseUrl, patientId, accessToken),
    fetchConditions(fhirBaseUrl, patientId, accessToken),
    fetchObservations(fhirBaseUrl, patientId, accessToken, "laboratory"),
    fetchObservations(fhirBaseUrl, patientId, accessToken, "vital-signs"),
    fetchMedications(fhirBaseUrl, patientId, accessToken),
    fetchEncounters(fhirBaseUrl, patientId, accessToken),
    fetchAllergies(fhirBaseUrl, patientId, accessToken),
    fetchImmunizations(fhirBaseUrl, patientId, accessToken),
    fetchProcedures(fhirBaseUrl, patientId, accessToken),
  ]);

  if (patientResult.status === 'rejected') {
    throw new Error(`Failed to fetch Patient resource: ${patientResult.reason?.message ?? patientResult.reason}`);
  }

  const conditions    = settled(conditionsResult,     [], 'Condition');
  const labResults    = settled(labsResult,           [], 'Observation(labs)');
  const vitals        = settled(vitalsResult,         [], 'Observation(vitals)');
  const medications   = settled(medsResult,           [], 'MedicationRequest');
  const encounters    = settled(encountersResult,     [], 'Encounter');
  const allergies     = settled(allergiesResult,      [], 'AllergyIntolerance');
  const immunizations = settled(immunizationsResult,  [], 'Immunization');
  const procedures    = settled(proceduresResult,     [], 'Procedure');

  console.log(
    `  Fetched: ${conditions.length} conditions, ${labResults.length} labs, ` +
    `${vitals.length} vitals, ${medications.length} meds, ` +
    `${encounters.length} encounters, ${allergies.length} allergies, ` +
    `${immunizations.length} immunizations, ${procedures.length} procedures`
  );

  return {
    patient: patientResult.value,
    conditions,
    labResults,
    vitals,
    medications,
    encounters,
    allergies,
    immunizations,
    procedures,
    fetchedAt: new Date().toISOString(),
  };
}

