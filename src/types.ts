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
  | FhirDiagnosticReport
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
  severity?: FhirCodeableConcept;
  bodySite?: FhirCodeableConcept[];
  onsetDateTime?: string;
  recordedDate?: string;
  note?: { text?: string }[];
  subject?: FhirReference;
}

export interface FhirObservation {
  resourceType: "Observation";
  id?: string;
  code?: FhirCodeableConcept;
  status?: string;
  category?: FhirCodeableConcept[];
  effectiveDateTime?: string;
  effectivePeriod?: { start?: string; end?: string };
  issued?: string;
  valueQuantity?: { value?: number; unit?: string; system?: string; code?: string };
  valueString?: string;
  valueBoolean?: boolean;
  valueInteger?: number;
  valueRange?: { low?: { value?: number; unit?: string }; high?: { value?: number; unit?: string } };
  valueRatio?: { numerator?: { value?: number; unit?: string }; denominator?: { value?: number; unit?: string } };
  valueCodeableConcept?: FhirCodeableConcept;
  component?: {
    code?: FhirCodeableConcept;
    valueQuantity?: { value?: number; unit?: string; system?: string; code?: string };
    valueString?: string;
    valueBoolean?: boolean;
    valueInteger?: number;
    valueRange?: { low?: { value?: number; unit?: string }; high?: { value?: number; unit?: string } };
    valueRatio?: { numerator?: { value?: number; unit?: string }; denominator?: { value?: number; unit?: string } };
    valueCodeableConcept?: FhirCodeableConcept;
  }[];
  interpretation?: FhirCodeableConcept[];
  referenceRange?: {
    low?: { value?: number; unit?: string; system?: string; code?: string };
    high?: { value?: number; unit?: string; system?: string; code?: string };
  }[];
  note?: { text?: string }[];
  subject?: FhirReference;
}

export interface FhirMedicationRequest {
  resourceType: "MedicationRequest";
  id?: string;
  medicationCodeableConcept?: FhirCodeableConcept;
  medicationReference?: FhirReference;
  status?: string;
  authoredOn?: string;
  encounter?: FhirReference;
  requester?: { agent?: FhirReference; onBehalfOf?: FhirReference };
  dosageInstruction?: { text?: string }[];
  dispenseRequest?: {
    validityPeriod?: { start?: string; end?: string };
    numberOfRepeatsAllowed?: number;
    quantity?: { value?: number; unit?: string; system?: string; code?: string };
    expectedSupplyDuration?: { value?: number; unit?: string; system?: string; code?: string };
  };
  note?: { text?: string }[];
  subject?: FhirReference;
}
 
export interface FhirEncounter {
  resourceType: "Encounter";
  id?: string;
  type?: FhirCodeableConcept[];
  period?: { start?: string; end?: string };
  status?: string;
  class?: FhirCoding;
  reasonCode?: FhirCodeableConcept[];
  hospitalization?: {
    admitSource?: FhirCodeableConcept;
    dischargeDisposition?: FhirCodeableConcept;
  };
  participant?: { type?: FhirCodeableConcept[]; individual?: FhirReference }[];
  location?: { location?: FhirReference; status?: string }[];
  subject?: FhirReference;
  _medications?: Array<{ name: string; status?: string; dosage?: string }>
}

export interface FhirAllergyIntolerance {
  resourceType: "AllergyIntolerance";
  id?: string;
  code?: FhirCodeableConcept;
  clinicalStatus?: FhirCodeableConcept;
  type?: string;
  category?: string[];
  criticality?: string;
  onsetDateTime?: string;
  reaction?: {
    substance?: FhirCodeableConcept;
    manifestation?: FhirCodeableConcept[];
    description?: string;
    severity?: string;
  }[];
  note?: { text?: string }[];
  patient?: FhirReference;
}

export interface FhirImmunization {
  resourceType: "Immunization";
  id?: string;
  vaccineCode?: FhirCodeableConcept;
  occurrenceDateTime?: string;
  status?: string;
  lotNumber?: string;
  manufacturer?: FhirReference;
  site?: FhirCodeableConcept;
  route?: FhirCodeableConcept;
  doseQuantity?: { value?: number; unit?: string; system?: string; code?: string };
  note?: { text?: string }[];
  patient?: FhirReference;
}

export interface FhirProcedure {
  resourceType: "Procedure";
  id?: string;
  code?: FhirCodeableConcept;
  performedDateTime?: string;
  performedPeriod?: { start?: string; end?: string };
  status?: string;
  reasonCode?: FhirCodeableConcept[];
  bodySite?: FhirCodeableConcept[];
  outcome?: FhirCodeableConcept;
  performer?: { actor?: FhirReference; 
  role?: FhirCodeableConcept }[];
  note?: { text?: string }[];
  subject?: FhirReference;
}

export interface FhirDiagnosticReport {
  resourceType: "DiagnosticReport";
  id?: string;
  code?: FhirCodeableConcept;
  status?: string;
  category?: FhirCodeableConcept[];
  effectiveDateTime?: string;
  effectivePeriod?: { start?: string; end?: string };
  issued?: string;
  performer?: FhirReference[];
  result?: FhirReference[];
  conclusion?: string;
  note?: { text?: string }[];
  presentedForm?: { contentType?: string; data?: string; title?: string }[];
  subject?: FhirReference;
}