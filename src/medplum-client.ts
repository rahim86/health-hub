// Singleton Medplum client. Call initMedplum() once at server startup.
// All functions here speak to the local Docker Medplum FHIR API (port 8103).

import { MedplumClient } from '@medplum/core';
import type { FhirResource } from './types';

export const medplum = new MedplumClient({
  baseUrl: process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/',
});

export async function initMedplum(): Promise<void> {
  const clientId = process.env.MEDPLUM_CLIENT_ID;
  const clientSecret = process.env.MEDPLUM_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'MEDPLUM_CLIENT_ID and MEDPLUM_CLIENT_SECRET must be set in .env.\n' +
      'Create a Client Application in Medplum admin (localhost:3000) → Admin → Project → Client Applications.'
    );
  }
  await medplum.startClientLogin(clientId, clientSecret);
  console.log('  Medplum: authenticated to', process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/');
}

const MEMBER_SYSTEM = 'https://familyhealthhub.local/members';
export const SOURCE_TAG_SYSTEM = 'https://familyhealthhub.local/source';

// ---- Patient management ----
// Each local family-member UUID is stored as a Patient identifier in Medplum.
// This lets us find the Medplum Patient by local UUID on every sync.

export interface PatientDemographics {
  name: string;
  birthDate?: string;
  gender?: string;
}

export async function getOrCreateMedplumPatient(
  memberId: string,
  demographics: PatientDemographics
): Promise<string> {
  const existing = await medplum.searchOne('Patient', {
    identifier: `${MEMBER_SYSTEM}|${memberId}`,
  } as any);
  if (existing) return existing.id!;

  const created = await medplum.createResource({
    resourceType: 'Patient',
    identifier: [{ system: MEMBER_SYSTEM, value: memberId }],
    name: [{ text: demographics.name }],
    ...(demographics.birthDate ? { birthDate: demographics.birthDate } : {}),
    ...(demographics.gender ? { gender: demographics.gender } : {}),
  } as any);
  return created.id!;
}

// ---- FHIR resource sync ----
// Writes raw FHIR resources from the EHR into Medplum.
// Uses the EHR resource ID + provider system as a stable upsert key.

export async function syncResourcesToMedplum(
  resources: FhirResource[],
  medplumPatientId: string,
  providerId: string
): Promise<number> {
  const ehrSystem = `https://familyhealthhub.local/ehr/${providerId}`;
  const patientRef = { reference: `Patient/${medplumPatientId}` };
  let count = 0;

  for (const resource of resources) {
    if (!resource?.resourceType || !(resource as any).id) continue;
    const ehrId = (resource as any).id as string;

    const tagged: any = {
      ...resource,
      meta: { tag: [{ system: SOURCE_TAG_SYSTEM, code: providerId }] },
      identifier: [
        ...((resource as any).identifier ?? []),
        { system: ehrSystem, value: ehrId },
      ],
    };
    if ('subject' in resource) tagged.subject = patientRef;
    if ('patient' in resource) tagged.patient = patientRef;

    try {
      const existing = await medplum.searchOne(resource.resourceType as any, {
        identifier: `${ehrSystem}|${ehrId}`,
        _fields: 'id',
      } as any);

      if (existing) {
        await medplum.updateResource({ ...tagged, id: existing.id });
      } else {
        await medplum.createResource(tagged);
      }
      count++;
    } catch (err: any) {
      console.error(`  Medplum upsert failed for ${resource.resourceType}/${ehrId}:`, err.message);
    }
  }
  return count;
}

// ---- Dashboard queries ----

// Follows Bundle.link "next" pages so high-volume resource types (e.g.
// Observation, which holds both clinical labs/vitals and any externally
// synced data like Apple Health samples) aren't silently truncated at the
// first page.
async function searchAllPages(
  resourceType: string,
  params: Record<string, string>,
  maxPages = 50
): Promise<any[]> {
  const resources: any[] = [];
  let bundle: any = await medplum.search(resourceType as any, { ...params, _count: '200' } as any);
  let page = 0;

  while (bundle) {
    resources.push(...(bundle.entry ?? []).map((e: any) => e.resource).filter(Boolean));
    const nextUrl = bundle.link?.find((l: any) => l.relation === 'next')?.url;
    page++;
    if (!nextUrl || page >= maxPages) break;
    bundle = await medplum.get(nextUrl);
  }

  return resources;
}

export async function getMedplumRecords(medplumPatientId: string, resourceType?: string) {
  const types = resourceType
    ? [resourceType]
    : ['Condition', 'Observation', 'MedicationRequest', 'Encounter',
       'AllergyIntolerance', 'Immunization', 'Procedure'];

  const results = await Promise.allSettled(
    types.map(t => searchAllPages(t, { patient: medplumPatientId }))
  );

  return results.flatMap((r, i) => {
    if (r.status === 'rejected') {
      console.error(`  Medplum search failed for ${types[i]}:`, r.reason?.message ?? r.reason);
      return [];
    }
    return r.value;
  });
}

export async function getMedplumLabTrends(medplumPatientId: string, loincCode: string) {
  const bundle = await medplum.search('Observation' as any, {
    patient: medplumPatientId,
    code: `http://loinc.org|${loincCode}`,
    _sort: 'date',
    _count: '100',
  } as any);
  return (bundle.entry ?? []).map((e: any) => e.resource).filter(Boolean);
}

export async function getMedplumResource(resourceType: string, id: string): Promise<any> {
  return medplum.readResource(resourceType as any, id);
}

export async function deleteMedplumResource(resourceType: string, id: string): Promise<void> {
  await medplum.deleteResource(resourceType as any, id);
}

export async function getMedplumSummary(medplumPatientId: string) {
  const [conditions, medications, observations, encounters, allergies, immunizations] =
    await Promise.all([
      medplum.search('Condition' as any, { patient: medplumPatientId, _summary: 'count' } as any),
      medplum.search('MedicationRequest' as any, { patient: medplumPatientId, _summary: 'count' } as any),
      medplum.search('Observation' as any, { patient: medplumPatientId, _summary: 'count' } as any),
      medplum.search('Encounter' as any, { patient: medplumPatientId, _summary: 'count' } as any),
      medplum.search('AllergyIntolerance' as any, { patient: medplumPatientId, _summary: 'count' } as any),
      medplum.search('Immunization' as any, { patient: medplumPatientId, _summary: 'count' } as any),
    ]);

  return {
    conditions: conditions.total ?? 0,
    medications: medications.total ?? 0,
    observations: observations.total ?? 0,
    encounters: encounters.total ?? 0,
    allergies: allergies.total ?? 0,
    immunizations: immunizations.total ?? 0,
    last_synced: new Date().toISOString(),
  };
}

// ---- EHR connection record ----
// Stores the EHR access token + patient link as a FHIR RelatedPerson extension
// keyed by "{medplumPatientId}-{providerId}" so re-auths overwrite cleanly.

export interface EhrConnection {
  provider_id: string;
  fhir_base_url: string;
  ehr_patient_id: string;
  access_token: string;
  refresh_token?: string;
  token_expires_at: number;
}

const TOKEN_SYSTEM = 'https://familyhealthhub.local/token';

export async function upsertConnectionInMedplum(
  medplumPatientId: string,
  conn: EhrConnection
): Promise<void> {
  const tokenKey = `${medplumPatientId}-${conn.provider_id}`;

  const existing = await medplum.searchOne('Basic' as any, {
    identifier: `${TOKEN_SYSTEM}|${tokenKey}`,
  } as any);

  const resource: any = {
    resourceType: 'Basic',
    identifier: [{ system: TOKEN_SYSTEM, value: tokenKey }],
    code: { coding: [{ system: TOKEN_SYSTEM, code: 'ehr-connection' }] },
    subject: { reference: `Patient/${medplumPatientId}` },
    extension: [
      { url: `${TOKEN_SYSTEM}/provider_id`,     valueString: conn.provider_id },
      { url: `${TOKEN_SYSTEM}/fhir_base_url`,   valueString: conn.fhir_base_url },
      { url: `${TOKEN_SYSTEM}/ehr_patient_id`,  valueString: conn.ehr_patient_id },
      { url: `${TOKEN_SYSTEM}/access_token`,    valueString: conn.access_token },
      { url: `${TOKEN_SYSTEM}/token_expires_at`,valueDecimal: conn.token_expires_at },
      ...(conn.refresh_token
        ? [{ url: `${TOKEN_SYSTEM}/refresh_token`, valueString: conn.refresh_token }]
        : []),
    ],
  };

  if (existing) {
    await medplum.updateResource({ ...resource, id: existing.id });
  } else {
    await medplum.createResource(resource);
  }
}

export async function disconnectEhrConnection(medplumPatientId: string, providerId: string): Promise<void> {
  const tokenKey = `${medplumPatientId}-${providerId}`;
  const existing = await medplum.searchOne('Basic' as any, {
    identifier: `${TOKEN_SYSTEM}|${tokenKey}`,
  } as any);
  if (existing) await medplum.deleteResource('Basic' as any, existing.id!);
}

// Deletes a patient's clinical records, EHR connections, and the Patient
// resource itself. Irreversible.
export async function deleteMedplumPatient(medplumPatientId: string): Promise<void> {
  const records = await getMedplumRecords(medplumPatientId);
  await Promise.all(
    records.map((r: any) =>
      medplum.deleteResource(r.resourceType, r.id).catch((err: any) =>
        console.error(`  Failed to delete ${r.resourceType}/${r.id}:`, err.message)
      )
    )
  );

  const connectionsBundle = await medplum.search('Basic' as any, {
    subject: `Patient/${medplumPatientId}`,
    code: 'ehr-connection',
    _count: '50',
  } as any);
  const connections = (connectionsBundle.entry ?? []).map((e: any) => e.resource).filter(Boolean);
  await Promise.all(
    connections.map((c: any) =>
      medplum.deleteResource('Basic' as any, c.id).catch((err: any) =>
        console.error(`  Failed to delete Basic/${c.id}:`, err.message)
      )
    )
  );

  await medplum.deleteResource('Patient' as any, medplumPatientId);
}

export async function getMedplumPatientId(memberId: string): Promise<string | undefined> {
  const patient = await medplum.searchOne('Patient', {
    identifier: `${MEMBER_SYSTEM}|${memberId}`,
  } as any);
  return patient?.id;
}

export async function getEhrConnectionsForPatient(medplumPatientId: string): Promise<EhrConnection[]> {
  const bundle = await medplum.search('Basic' as any, {
    subject: `Patient/${medplumPatientId}`,
    code: 'ehr-connection',
    _count: '50',
  } as any);
  const resources = (bundle.entry ?? []).map((e: any) => e.resource).filter(Boolean);
  return resources.map((r: any) => {
    const ext = (name: string) => r.extension?.find((e: any) => e.url === `${TOKEN_SYSTEM}/${name}`);
    return {
      provider_id: ext('provider_id')?.valueString ?? '',
      fhir_base_url: ext('fhir_base_url')?.valueString ?? '',
      ehr_patient_id: ext('ehr_patient_id')?.valueString ?? '',
      access_token: ext('access_token')?.valueString ?? '',
      refresh_token: ext('refresh_token')?.valueString,
      token_expires_at: ext('token_expires_at')?.valueDecimal ?? 0,
    } as EhrConnection;
  });
}

export async function listMedplumPatients(): Promise<any[]> {
  const bundle = await medplum.search('Patient' as any, {
    _count: '200',
    _sort: '-_lastUpdated',
  } as any);
  return (bundle.entry ?? []).map((e: any) => e.resource).filter(Boolean);
}
