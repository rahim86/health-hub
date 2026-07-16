// ============================================================
// types.ts — Core type definitions
// ============================================================

// --- SMART Discovery & Auth ---

export interface SmartConfiguration {
  authorization_endpoint: string;
  token_endpoint: string;
  introspection_endpoint?: string;
  revocation_endpoint?: string;
  capabilities: string[];
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  patient?: string;            // FHIR Patient ID at this EHR
  refresh_token?: string;
  id_token?: string;           // OpenID Connect
}

export interface AuthState {
  provider_id: string;
  code_verifier: string;       // PKCE
  state: string;               // CSRF protection
  member_id: string;           // which family member initiated this
}

// --- Provider / EHR Configuration ---

export interface ProviderConfig {
  id: string;                  // e.g. "epic", "oracle", "meditech_general"
  name: string;                // display name
  fhir_base_url: string;       // e.g. "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4"
  client_id: string;           // from your app registration
  scopes: string[];
}

// --- FHIR Resources (simplified, typed subsets) ---

export interface FhirBundle {
  resourceType: "Bundle";
  type: string;
  total?: number;
  entry?: FhirBundleEntry[];
  link?: { relation: string; url: string }[];
}

export interface FhirBundleEntry {
  resource: FhirResource;
  fullUrl?: string;
}

export type FhirResource =
  | FhirPatient
  | FhirCondition
  | FhirObservation
  | FhirMedicationRequest
  | FhirEncounter
  | FhirAllergyIntolerance
  | FhirImmunization
  | FhirProcedure
  | GenericFhirResource;

export interface GenericFhirResource {
  resourceType: string;
  id?: string;
  [key: string]: unknown;
}

export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

export interface FhirReference {
  reference?: string;
  display?: string;
}

export interface FhirPatient {
  resourceType: "Patient";
  id: string;
  name?: { given?: string[]; family?: string; use?: string }[];
  birthDate?: string;
  gender?: string;
}

export interface FhirCondition {
  resourceType: "Condition";
  id?: string;
  code?: FhirCodeableConcept;
  clinicalStatus?: FhirCodeableConcept;
  verificationStatus?: FhirCodeableConcept;
  onsetDateTime?: string;
  subject?: FhirReference;
}

export interface FhirObservation {
  resourceType: "Observation";
  id?: string;
  code?: FhirCodeableConcept;
  valueQuantity?: { value?: number; unit?: string; system?: string; code?: string };
  valueString?: string;
  effectiveDateTime?: string;
  status?: string;
  category?: FhirCodeableConcept[];
  subject?: FhirReference;
}

export interface FhirMedicationRequest {
  resourceType: "MedicationRequest";
  id?: string;
  medicationCodeableConcept?: FhirCodeableConcept;
  medicationReference?: FhirReference;
  status?: string;
  authoredOn?: string;
  dosageInstruction?: { text?: string }[];
  subject?: FhirReference;
}

export interface FhirEncounter {
  resourceType: "Encounter";
  id?: string;
  type?: FhirCodeableConcept[];
  period?: { start?: string; end?: string };
  status?: string;
  class?: FhirCoding;
  subject?: FhirReference;
}

export interface FhirAllergyIntolerance {
  resourceType: "AllergyIntolerance";
  id?: string;
  code?: FhirCodeableConcept;
  clinicalStatus?: FhirCodeableConcept;
  type?: string;
  category?: string[];
  criticality?: string;
  patient?: FhirReference;
}

export interface FhirImmunization {
  resourceType: "Immunization";
  id?: string;
  vaccineCode?: FhirCodeableConcept;
  occurrenceDateTime?: string;
  status?: string;
  patient?: FhirReference;
}

export interface FhirProcedure {
  resourceType: "Procedure";
  id?: string;
  code?: FhirCodeableConcept;
  performedDateTime?: string;
  performedPeriod?: { start?: string; end?: string };
  status?: string;
  subject?: FhirReference;
}

