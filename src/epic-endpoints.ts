// ============================================================
// epic-endpoints.ts — Epic hospital FHIR endpoint directory
// ============================================================
//
// epic-endpoints-R4.json is a FHIR Bundle of Endpoint resources (Epic's
// published directory of per-hospital FHIR R4 base URLs). This loads it
// once at startup into a flat {name, address} list for the "Connect via
// Epic" hospital picker in the dashboard.
//
// ============================================================

import fs from "fs";
import path from "path";
import { normalizeBaseUrl } from "./fhir-client";

export interface EpicEndpoint {
  name: string;
  address: string; // normalized: no trailing slash
}

function loadEpicEndpoints(): EpicEndpoint[] {
  const filePath = path.join(__dirname, "..", "epic-endpoints-R4.json");

  let bundle: { entry?: { resource?: any }[] };
  try {
    bundle = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err: any) {
    console.warn(`  [epic-endpoints] Could not load ${filePath}: ${err.message}`);
    return [];
  }

  const endpoints: EpicEndpoint[] = [];
  for (const entry of bundle.entry ?? []) {
    const resource = entry.resource;
    const address = resource?.address;
    if (!address) continue;
    const name = resource.contained?.[0]?.name || resource.name || address;
    endpoints.push({ name, address: normalizeBaseUrl(address) });
  }

  endpoints.sort((a, b) => a.name.localeCompare(b.name));
  return endpoints;
}

export const EPIC_ENDPOINTS: EpicEndpoint[] = loadEpicEndpoints();

export function findEpicEndpoint(address: string): EpicEndpoint | undefined {
  const normalized = normalizeBaseUrl(address);
  return EPIC_ENDPOINTS.find((e) => e.address === normalized);
}
