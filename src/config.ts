// ============================================================
// config.ts — EHR vendor configurations
// ============================================================
//
// Each provider entry contains the FHIR base URL and your
// registered client_id. The SMART discovery endpoint is derived
// automatically: {fhir_base_url}/.well-known/smart-configuration
//
// IMPORTANT: The fhir_base_url varies per hospital, not per vendor.
// Epic has hundreds of endpoints (one per health system). The URLs
// below are the SANDBOX endpoints for development. In production,
// you'll need the specific URL for each hospital your family uses.
//
// To find your hospital's Epic FHIR endpoint:
//   https://open.epic.com/MyApps/Endpoints
//
// To find your hospital's Oracle Health endpoint:
//   Ask your provider or check their patient portal docs
//
// ============================================================

import { ProviderConfig } from "./types";

// Standard patient-facing scopes (same across all three vendors)
const PATIENT_SCOPES = [
  "openid",                          // OpenID Connect identity
  "fhirUser",                        // FHIR user identity
  "launch/patient",                  // standalone patient launch
  "patient/Patient.read",            // demographics
  "patient/Condition.read",          // diagnoses / problem list
  "patient/Observation.read",        // labs, vitals
  "patient/MedicationRequest.read",  // prescriptions
  "patient/Encounter.read",          // visits
  "patient/AllergyIntolerance.read", // allergies
  "patient/Immunization.read",       // vaccines
  "patient/Procedure.read",          // procedures
  "patient/DocumentReference.read",  // visit summaries, C-CDAs
  "offline_access",                  // refresh token (not all EHRs honor this)
];

// ---- SANDBOX configurations (for development) ----

export const EPIC_SANDBOX: ProviderConfig = {
  id: "epic_sandbox",
  name: "Epic (Sandbox)",
  fhir_base_url: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",
  client_id: process.env.EPIC_CLIENT_ID,
  scopes: PATIENT_SCOPES,
};

export const ORACLE_SANDBOX: ProviderConfig = {
  id: "oracle_sandbox",
  name: "Oracle Health (Sandbox)",
  fhir_base_url: "https://fhir-myrecord.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d",
  client_id: process.env.ORACLE_CLIENT_ID,
  scopes: PATIENT_SCOPES,
};

export const MEDITECH_SANDBOX: ProviderConfig = {
  id: "meditech_sandbox",
  name: "MEDITECH (Sandbox)",
  // MEDITECH doesn't have a public sandbox like Epic/Oracle.
  // Replace with your hospital's Expanse FHIR endpoint.
  fhir_base_url: "https://YOUR_HOSPITAL.meditech.com/fhir/r4",
  client_id: process.env.MEDITECH_CLIENT_ID || "YOUR_MEDITECH_CLIENT_ID",
  scopes: PATIENT_SCOPES,
};

// ---- PRODUCTION endpoint templates ----
// Clone these and set the fhir_base_url to your specific hospital.
//
// Example: Your family uses Mass General (Epic), a VA hospital
// (Oracle Health), and a community hospital (MEDITECH).
//
//   export const MASS_GENERAL: ProviderConfig = {
//     id: "mass_general",
//     name: "Mass General Brigham",
//     fhir_base_url: "https://fhir.mgb.org/interconnect-fhir-oauth/api/FHIR/R4",
//     client_id: process.env.EPIC_CLIENT_ID,  // same client_id works across all Epic sites
//     scopes: PATIENT_SCOPES,
//   };
//
// NOTE: Epic uses ONE client_id across all Epic hospitals.
//       Oracle Health requires per-site provisioning in some cases.
//       MEDITECH requires per-hospital registration.

// ---- Active provider list ----
// Add your family's actual providers here.

export const PROVIDERS: ProviderConfig[] = [
  EPIC_SANDBOX,
  ORACLE_SANDBOX,
  // MEDITECH_SANDBOX,  // uncomment when you have credentials
];

// ---- App configuration ----

export const APP_CONFIG = {
  port: parseInt(process.env.PORT || "4000"),
  redirect_uri: process.env.REDIRECT_URI || "http://localhost:4000/callback",
  session_secret: process.env.SESSION_SECRET || "change-this-in-production",
};
