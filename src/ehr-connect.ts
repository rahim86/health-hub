// OAuth handlers for SMART on FHIR standalone launch.
//
// startConnect  → redirects the user's browser to the EHR login page.
//                 fhirclient handles SMART discovery + PKCE internally,
//                 storing the code_verifier in the Express session.
//
// handleCallback → receives the authorization code after the user logs in,
//                  exchanges it for tokens (fhirclient verifies state/PKCE),
//                  fetches FHIR resources from the EHR, and writes them to
//                  Medplum (not SQLite).
//
// Registered redirect URI at Epic / Oracle dev portals: http://localhost:PORT/callback

import { v4 as uuidv4 } from 'uuid';
import FHIR from 'fhirclient';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Request, Response } from 'express';
import { PROVIDERS, APP_CONFIG } from './config';
import { syncPatientData } from './fhir-client';
import { findEpicEndpoint } from './epic-endpoints';
import {
  getOrCreateMedplumPatient,
  syncResourcesToMedplum,
  upsertConnectionInMedplum,
  PatientDemographics,
} from './medplum-client';
import type { FhirPatient } from './types';

// Step 1: redirect user to EHR login.
// Called by GET /connect/:providerId              → SSO for a brand-new patient
//        or GET /connect/:providerId?member=UUID   → link another provider to an existing patient
//        or GET /connect/:providerId?fhir_base_url=... → Epic only: use a specific
//           hospital's FHIR endpoint (from the epic-endpoints-R4.json directory)
//           instead of the EPIC_SANDBOX default
export async function startConnect(req: Request, res: Response): Promise<void> {
  const providerId = (req.params.providerId ?? req.query.providerId) as string;
  // No member param means "connect a new patient" — the local member ID is
  // minted here and the actual Patient record is created from EHR demographics
  // once the SSO callback returns.
  const memberId = (req.query.member as string) || uuidv4();

  const provider = PROVIDERS.find(p => p.id === providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  // Only Epic supports the hospital picker — the override must match a known
  // entry from the endpoint directory, otherwise the ?fhir_base_url= query
  // param would let a caller redirect the SMART discovery/authorize flow to
  // an arbitrary URL.
  const requestedBaseUrl = req.query.fhir_base_url as string | undefined;
  let fhirBaseUrl = provider.fhir_base_url;
  if (requestedBaseUrl && provider.id.startsWith('epic')) {
    const endpoint = findEpicEndpoint(requestedBaseUrl);
    if (!endpoint) throw new Error('Unknown Epic FHIR endpoint');
    fhirBaseUrl = endpoint.address;
  }

  req.session.pendingMemberId = memberId;
  req.session.pendingProvider = providerId;
  req.session.pendingFhirBaseUrl = fhirBaseUrl;

  // fhirclient discovers .well-known/smart-configuration from the FHIR base URL,
  // generates a PKCE code_verifier + challenge, stores them in the session,
  // and redirects the browser to the EHR's authorization_endpoint.
  await FHIR(req as unknown as IncomingMessage, res as unknown as ServerResponse).authorize({
    iss: fhirBaseUrl,
    clientId: provider.client_id,
    scope: provider.scopes.join(' '),
    redirectUri: APP_CONFIG.redirect_uri,
    pkceMode: 'required',
  });
}

// Step 2: handle the callback after patient authenticates at the EHR.
// Called by GET /callback?code=AUTH_CODE&state=STATE
export async function handleCallback(req: Request, res: Response): Promise<void> {
  // fhirclient validates the state nonce (CSRF protection) and PKCE verifier,
  // then exchanges the authorization code for access + refresh tokens.
  const client = await FHIR(req as unknown as IncomingMessage, res as unknown as ServerResponse).ready();

  const ehrPatientId = client.getPatientId();
  if (!ehrPatientId) {
    throw new Error(
      'EHR did not return a patient context. ' +
      'Make sure "launch/patient" scope is registered in your EHR app.'
    );
  }

  const token = client.state.tokenResponse;
  if (!token?.access_token) throw new Error('fhirclient did not return an access token.');

  const memberId = req.session.pendingMemberId!;
  const providerId = req.session.pendingProvider!;
  const provider = PROVIDERS.find(p => p.id === providerId)!;
  // Set in startConnect — for Epic this may be a specific hospital's FHIR
  // endpoint from the directory rather than provider.fhir_base_url.
  const fhirBaseUrl = req.session.pendingFhirBaseUrl || provider.fhir_base_url;

  // Fetch the patient's demographics + all clinical resources from the EHR
  // before touching Medplum, so a brand-new patient is created with their
  // real name/DOB/gender rather than a placeholder.
  const data = await syncPatientData(fhirBaseUrl, ehrPatientId, token.access_token);
  const demographics = extractDemographics(data.patient, memberId);

  console.log(`\n  OAuth success: patient="${demographics.name}" provider="${provider.name}" ehr_patient="${ehrPatientId}"`);

  const medplumPatientId = await getOrCreateMedplumPatient(memberId, demographics);

  await upsertConnectionInMedplum(medplumPatientId, {
    provider_id: providerId,
    fhir_base_url: fhirBaseUrl,
    ehr_patient_id: ehrPatientId,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_expires_at: Date.now() / 1000 + (token.expires_in ?? 3600),
  });

  const allResources = [
    ...data.conditions, ...data.observations,
    ...data.medications, ...data.encounters, ...data.allergies,
    ...data.immunizations, ...data.procedures,
  ];

  // Write every resource into Medplum, tagged with the source EHR.
  const count = await syncResourcesToMedplum(allResources, medplumPatientId, providerId);
  console.log(`  Synced ${count} resources → Medplum patient ${medplumPatientId}\n`);

  res.redirect('/?connected=true');
}

function extractDemographics(patient: FhirPatient | undefined, fallbackId: string): PatientDemographics {
  const n = patient?.name?.[0];
  const name = n
    ? (n as any).text || [...(n.given ?? []), n.family].filter(Boolean).join(' ')
    : undefined;
  return {
    name: name || fallbackId,
    birthDate: patient?.birthDate,
    gender: patient?.gender,
  };
}
