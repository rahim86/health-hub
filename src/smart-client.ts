// ============================================================
// smart-client.ts — SMART on FHIR standalone launch client
// ============================================================
//
// This module implements the SMART App Launch Framework (v2.1)
// for standalone patient-facing apps. It handles:
//
//   1. Discovery  — fetch .well-known/smart-configuration
//   2. Authorize  — build the OAuth URL with PKCE
//   3. Exchange   — swap auth code for access_token
//   4. Refresh    — use refresh_token to get a new access_token
//
// The same code works for Epic, Oracle Health, and MEDITECH
// because SMART standardizes the discovery + OAuth flow.
// The only vendor-specific input is the FHIR base URL.
//
// ============================================================

import crypto from "crypto";
import {
  SmartConfiguration,
  TokenResponse,
  AuthState,
  ProviderConfig,
} from "./types";

// In-memory store for pending auth states.
// In production, use a session store (Redis, encrypted cookies, etc.)
const pendingAuthStates = new Map<string, AuthState>();

// Cache discovered SMART configurations to avoid redundant fetches
const discoveryCache = new Map<string, SmartConfiguration>();

// ---- Step 1: Discovery ----
// Every SMART-enabled FHIR server publishes its OAuth endpoints at:
//   {fhir_base_url}/.well-known/smart-configuration
//
// This means your app never hardcodes auth URLs — it discovers
// them dynamically. One code path, any vendor.

export async function discoverSmartConfig(
  fhirBaseUrl: string
): Promise<SmartConfiguration> {
  const cached = discoveryCache.get(fhirBaseUrl);
  if (cached) return cached;

  const wellKnownUrl = `${fhirBaseUrl}/.well-known/smart-configuration`;

  const response = await fetch(wellKnownUrl, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    // Fallback: some older servers put SMART metadata in the
    // CapabilityStatement's security extension instead.
    return discoverFromCapabilityStatement(fhirBaseUrl);
  }

  const config: SmartConfiguration = await response.json();
  discoveryCache.set(fhirBaseUrl, config);
  return config;
}

// Fallback discovery from CapabilityStatement (FHIR /metadata endpoint)
async function discoverFromCapabilityStatement(
  fhirBaseUrl: string
): Promise<SmartConfiguration> {
  const response = await fetch(`${fhirBaseUrl}/metadata`, {
    headers: { Accept: "application/fhir+json" },
  });

  if (!response.ok) {
    throw new Error(
      `Cannot discover SMART config for ${fhirBaseUrl}. ` +
        `Neither .well-known/smart-configuration nor /metadata responded.`
    );
  }

  const capabilityStatement = await response.json();

  // OAuth endpoints are in rest[0].security.extension
  const security = capabilityStatement?.rest?.[0]?.security;
  const oauthExtension = security?.extension?.find(
    (ext: any) =>
      ext.url ===
      "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris"
  );

  if (!oauthExtension?.extension) {
    throw new Error(
      `FHIR server at ${fhirBaseUrl} does not advertise SMART OAuth endpoints.`
    );
  }

  const getExtValue = (url: string): string =>
    oauthExtension.extension.find((e: any) => e.url === url)?.valueUri || "";

  const config: SmartConfiguration = {
    authorization_endpoint: getExtValue("authorize"),
    token_endpoint: getExtValue("token"),
    capabilities: [],
  };

  discoveryCache.set(fhirBaseUrl, config);
  return config;
}

// ---- Step 2: Build Authorization URL ----
// Generates the OAuth authorization URL with PKCE (S256).
// The user's browser redirects to the EHR's login page (MyChart, etc.)
//
// PKCE protects against auth code interception — required by
// SMART App Launch v2.1 for public clients (which your app is,
// since it runs in a browser or local server without a client_secret).

export async function buildAuthorizationUrl(
  provider: ProviderConfig,
  memberId: string,
  redirectUri: string
): Promise<string> {
  const smartConfig = await discoverSmartConfig(provider.fhir_base_url);

  // Generate PKCE code_verifier (43-128 chars, URL-safe)
  const codeVerifier = crypto.randomBytes(32).toString("base64url");

  // Derive code_challenge = BASE64URL(SHA256(code_verifier))
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  // Random state for CSRF protection
  const state = crypto.randomBytes(16).toString("hex");

  // Store state so we can validate on callback
  pendingAuthStates.set(state, {
    provider_id: provider.id,
    code_verifier: codeVerifier,
    state,
    member_id: memberId,
  });

  // Build the authorization URL
  const params = new URLSearchParams({
    response_type: "code",
    client_id: provider.client_id,
    redirect_uri: redirectUri,
    scope: provider.scopes.join(" "),
    state,
    aud: provider.fhir_base_url,       // required by SMART — identifies the FHIR server
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `${smartConfig.authorization_endpoint}?${params.toString()}`;
}

// ---- Step 3: Exchange Auth Code for Tokens ----
// After the user authenticates at the EHR portal, they're redirected
// back to your app with an authorization code. Exchange it for tokens.
//
// The response includes:
//   - access_token  (use this for FHIR API calls)
//   - patient       (FHIR Patient ID at this EHR — this is the key link)
//   - refresh_token (if the EHR supports offline_access)

export async function exchangeCodeForToken(
  code: string,
  state: string,
  redirectUri: string,
  providers: ProviderConfig[]
): Promise<{ tokenResponse: TokenResponse; authState: AuthState }> {
  // Validate state matches a pending auth
  const authState = pendingAuthStates.get(state);
  if (!authState) {
    throw new Error("Invalid or expired OAuth state. Possible CSRF attack.");
  }

  // Clean up — state is single-use
  pendingAuthStates.delete(state);

  // Find the provider config
  const provider = providers.find((p) => p.id === authState.provider_id);
  if (!provider) {
    throw new Error(`Unknown provider: ${authState.provider_id}`);
  }

  // Discover the token endpoint
  const smartConfig = await discoverSmartConfig(provider.fhir_base_url);

  // Exchange the code
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: provider.client_id,
    code_verifier: authState.code_verifier,   // PKCE proof
  });

  const response = await fetch(smartConfig.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Token exchange failed (${response.status}): ${errorBody}`
    );
  }

  const tokenResponse: TokenResponse = await response.json();

  return { tokenResponse, authState };
}

// ---- Step 4: Refresh Token ----
// Access tokens are short-lived (usually 5-60 minutes depending on EHR).
// If you got a refresh_token, use it to get a new access_token without
// sending the user back through the login flow.
//
// Not all EHRs issue refresh tokens. Epic does for patient-facing apps.
// Oracle Health and MEDITECH support varies by site configuration.

export async function refreshAccessToken(
  provider: ProviderConfig,
  refreshToken: string
): Promise<TokenResponse> {
  const smartConfig = await discoverSmartConfig(provider.fhir_base_url);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: provider.client_id,
  });

  const response = await fetch(smartConfig.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Token refresh failed (${response.status}): ${errorBody}. ` +
        `User may need to re-authenticate.`
    );
  }

  return response.json();
}

// ---- Utility: Check if token is expired ----

export function isTokenExpired(expiresAt: number, bufferSeconds = 60): boolean {
  return Date.now() / 1000 > expiresAt - bufferSeconds;
}

// ---- Utility: Get valid access token (auto-refresh if needed) ----

export async function getValidAccessToken(
  provider: ProviderConfig,
  connection: { access_token: string; refresh_token?: string; token_expires_at: number }
): Promise<string> {
  if (!isTokenExpired(connection.token_expires_at)) {
    return connection.access_token;
  }

  if (!connection.refresh_token) {
    throw new Error(
      `Access token expired for ${provider.name} and no refresh token available. ` +
        `User must re-authenticate.`
    );
  }

  const newTokens = await refreshAccessToken(provider, connection.refresh_token);
  // Caller should persist these new tokens
  connection.access_token = newTokens.access_token;
  connection.token_expires_at = Date.now() / 1000 + newTokens.expires_in;
  if (newTokens.refresh_token) {
    connection.refresh_token = newTokens.refresh_token;
  }

  return newTokens.access_token;
}
