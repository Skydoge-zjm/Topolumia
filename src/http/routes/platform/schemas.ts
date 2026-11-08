import * as z from "zod/v4";
import { recordBatchSchema } from "../../../domain/research/record-ingestion.js";
import { sendJson } from "../../../lib/http.js";

import {
  researchEventSchema,
  topologyPatchProposalSchema,
  topologyCuratorResultSchema,
  topologyCuratorTriggerSchema,
  topologyCuratorTriggerResultSchema,
  topologyCuratorTriggerStatusSchema,
} from "../../../domain/schemas.js";

export async function handlePlatformSchemasRoutes(context) {
  const { request, response, pathname } = context;

  if (pathname === "/api/schemas/record-ingestion" && request.method === "GET") { sendJson(response, 200, z.toJSONSchema(recordBatchSchema)); return true; }
  if (pathname === "/api/schemas/research-event" && request.method === "GET") {
    sendJson(response, 200, researchEventSchema);
    return true;
  }
  if (pathname === "/api/schemas/topology-patch" && request.method === "GET") {
    sendJson(response, 200, topologyPatchProposalSchema);
    return true;
  }
  if (
    pathname === "/api/schemas/topology-curator-result" &&
    request.method === "GET"
  ) {
    sendJson(response, 200, topologyCuratorResultSchema);
    return true;
  }
  if (
    pathname === "/api/schemas/topology-curator-trigger" &&
    request.method === "GET"
  ) {
    sendJson(response, 200, topologyCuratorTriggerSchema);
    return true;
  }
  if (
    pathname === "/api/schemas/topology-curator-trigger-result" &&
    request.method === "GET"
  ) {
    sendJson(response, 200, topologyCuratorTriggerResultSchema);
    return true;
  }
  if (
    pathname === "/api/schemas/topology-curator-trigger-status" &&
    request.method === "GET"
  ) {
    sendJson(response, 200, topologyCuratorTriggerStatusSchema);
    return true;
  }

  return false;
}
