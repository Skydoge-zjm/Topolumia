import * as z from "zod/v4";
import { objectRefSchema } from "./research/object-schemas.js";
const researchObjectReference = z.toJSONSchema(objectRefSchema);
delete researchObjectReference.$schema;
const shortString = { type: "string", minLength: 1, maxLength: 2_000 };

export const researchEventSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ResearchEventV1",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "type", "occurredAt", "actor", "sessionId", "nodeIds", "sourceRefs", "payload"],
  properties: {
    schemaVersion: { type: "string", const: "research-event.v1" },
    id: { type: "string", minLength: 1, maxLength: 240 },
    type: { type: "string", enum: ["agentMessage", "toolCall", "toolResult", "humanResearchMove", "topologyChange"] },
    occurredAt: { type: "string", format: "date-time" },
    actor: { type: "string", minLength: 1, maxLength: 120 },
    sessionId: { type: ["string", "null"], maxLength: 240 },
    nodeIds: { type: "array", maxItems: 80, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 240 } },
    sourceRefs: { type: "array", maxItems: 80, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1_000 } },
    payload: { type: "object" },
  },
};

const bilingualText = {
  type: "object",
  additionalProperties: false,
  required: ["zh", "en"],
  properties: { zh: shortString, en: shortString },
};

export const topologyPatchProposalSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "TopologyPatchProposalV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "id", "idempotencyKey", "baseStateVersion", "eventRange",
    "reason", "sourceRefs", "evidenceNodeIds", "curator", "operations",
  ],
  properties: {
    schemaVersion: { type: "string", const: "topology-patch-proposal.v1" },
    id: { type: "string", minLength: 1, maxLength: 240 },
    idempotencyKey: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    baseStateVersion: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    sourceStateVersion: { type: ["string", "null"], pattern: "^sha256:[a-f0-9]{64}$" },
    eventRange: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to"],
      properties: {
        from: { type: ["string", "null"], maxLength: 240 },
        to: { type: ["string", "null"], maxLength: 240 },
      },
    },
    reason: shortString,
    reasonEn: shortString,
    sourceRefs: { type: "array", maxItems: 80, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1_000 } },
    evidenceNodeIds: { type: "array", maxItems: 80, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 240 } },
    curator: {
      type: "object",
      additionalProperties: false,
      required: ["adapter", "mode", "model"],
      properties: {
        adapter: { type: "string", minLength: 1, maxLength: 120 },
        mode: { type: "string", enum: ["mock", "real"] },
        model: { type: "string", minLength: 1, maxLength: 120 },
      },
    },
    provenance: {
      type: "object",
      additionalProperties: false,
      properties: {
        actorType: { type: "string", enum: ["human", "agent", "system"] },
        actorId: { type: ["string", "null"], maxLength: 240 },
        principalId: { type: ["string", "null"], maxLength: 240 },
        projectId: { type: ["string", "null"], maxLength: 240 },
        role: { type: ["string", "null"], maxLength: 120 },
      },
    },
    operations: {
      type: "array",
      maxItems: 24,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "node"],
            properties: {
              op: { type: "string", const: "addNode" },
              node: {
                type: "object",
                additionalProperties: false,
                required: ["id", "kind", "code", "position", "label", "summary", "status", "data"],
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 240 },
                  kind: { type: "string", minLength: 1, maxLength: 120 },
                  code: { type: "string", minLength: 1, maxLength: 40 },
                  position: {
                    type: "object",
                    additionalProperties: false,
                    required: ["x", "y"],
                    properties: { x: { type: "number" }, y: { type: "number" } },
                  },
                  label: bilingualText,
                  summary: bilingualText,
                  status: { type: "string", const: "candidate" },
                  data: { type: "object" },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "edge"],
            properties: {
              op: { type: "string", const: "addEdge" },
              edge: {
                type: "object",
                additionalProperties: false,
                required: ["id", "from", "to", "type", "label", "status"],
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 240 },
                  from: researchObjectReference,
                  to: researchObjectReference,
                  type: { type: "string", minLength: 1, maxLength: 120 },
                  label: bilingualText,
                  status: { type: "string", const: "candidate" },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "nodeId", "patch"],
            properties: {
              op: { type: "string", const: "updateNode" },
              nodeId: { type: "string", minLength: 1, maxLength: 240 },
              patch: {
                type: "object",
                additionalProperties: false,
                minProperties: 1,
                properties: { label: bilingualText, summary: bilingualText, status: { type: "string", minLength: 1, maxLength: 80 } },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op"],
            properties: { op: { type: "string", const: "noop" } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "nodeId"],
            properties: { op: { type: "string", const: "deleteNode" }, nodeId: { type: "string", minLength: 1, maxLength: 240 } },
          },
        ],
      },
    },
  },
};

export const topologyCuratorResultSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "TopologyCuratorResultV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "disposition", "summary", "reason", "sourceRefs",
    "evidenceNodeIds", "inspectedNodeIds", "inspectedEdgeIds", "uncertainties", "questions",
  ],
  properties: {
    schemaVersion: { type: "string", const: "topology-curator-result.v1" },
    disposition: { type: "string", enum: ["proposal", "no_op", "needs_clarification"] },
    summary: shortString,
    reason: shortString,
    reasonEn: shortString,
    sourceRefs: { type: "array", maxItems: 80, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1_000 } },
    evidenceNodeIds: { type: "array", maxItems: 80, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 240 } },
    inspectedNodeIds: { type: "array", maxItems: 160, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 240 } },
    inspectedEdgeIds: { type: "array", maxItems: 240, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 240 } },
    uncertainties: { type: "array", maxItems: 24, items: shortString },
    questions: { type: "array", maxItems: 24, items: shortString },
    patch: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["operations"],
          properties: {
            operations: topologyPatchProposalSchema.properties.operations,
          },
        },
        { type: "null" },
      ],
    },
    runId: { type: "string", minLength: 1, maxLength: 240 },
    model: { type: "string", minLength: 1, maxLength: 120 },
    threadId: { type: ["string", "null"], maxLength: 240 },
    usage: { type: ["object", "null"] },
    explorationTrace: { type: ["object", "null"] },
    workspacePath: { type: ["string", "null"], maxLength: 1_000 },
  },
};

export const topologyCuratorTriggerSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "TopologyCuratorTriggerV1",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "string", const: "topology-curator-trigger.v1" },
    mode: { type: "string", enum: ["manual", "suggested", "background"] },
    cause: { type: "string", enum: ["user_request", "session_checkpoint", "experiment_delta", "source_delta", "topology_changed", "idle_batch", "continuity_break", "formal_state_request"] },
    entryContext: { type: ["object", "null"] },
    workingContext: { type: ["object", "null"] },
    sessionId: { type: ["string", "null"], maxLength: 240 },
    eventIds: { type: "array", maxItems: 240, items: { type: "string", minLength: 1, maxLength: 1_000 } },
    nodeIds: { type: "array", maxItems: 80, items: { type: "string", minLength: 1, maxLength: 1_000 } },
    edgeIds: { type: "array", maxItems: 160, items: { type: "string", minLength: 1, maxLength: 1_000 } },
    sourceRefs: { type: "array", maxItems: 80, items: { type: "string", minLength: 1, maxLength: 1_000 } },
    baseTopologyVersion: { type: ["string", "null"], maxLength: 240 },
    sourceStateVersion: { type: ["string", "null"], maxLength: 240 },
    requestedAt: { type: "string", format: "date-time" },
    locale: { type: "string", enum: ["zh", "en"] },
    force: { type: "boolean" },
    operation: { type: ["string", "null"], maxLength: 500 },
    focus: { type: ["string", "object", "null"] },
    continuityContext: { type: ["string", "object", "null"] },
  },
};

export const topologyCuratorTriggerResultSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "TopologyCuratorTriggerResultV1",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "status", "deduplicated", "requiresConfirmation", "trigger"],
  properties: {
    schemaVersion: { type: "string", const: "topology-curator-trigger-result.v1" },
    status: { type: "string", enum: ["idle", "suggested", "queued", "running", "available", "cooldown", "skipped", "error"] },
    deduplicated: { type: "boolean" },
    requiresConfirmation: { type: "boolean" },
    fingerprint: { type: ["string", "null"], maxLength: 240 },
    trigger: { type: "object" },
    result: { anyOf: [topologyCuratorResultSchema, { type: "null" }] },
    triggerId: { type: ["string", "null"], maxLength: 240 },
    suggestionId: { type: ["string", "null"], maxLength: 240 },
    reason: { type: ["string", "null"], maxLength: 500 },
    pendingEventCount: { type: "integer", minimum: 0 },
    pendingEventIds: { type: "array", items: { type: "string" } },
    running: { type: "boolean" },
    cooldownUntil: { type: ["string", "null"] },
    lastActivityAt: { type: ["string", "null"] },
    last: { type: ["object", "null"] },
    history: { type: "array" },
    automation: { type: "object" },
  },
};

export const topologyCuratorTriggerStatusSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "TopologyCuratorTriggerStatusV1",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "status", "pendingEventCount", "pendingEventIds", "running", "cooldownUntil", "lastActivityAt", "history", "automation"],
  properties: {
    schemaVersion: { type: "string", const: "topology-curator-trigger-result.v1" },
    status: { type: "string", enum: ["idle", "suggested", "queued", "running", "available", "cooldown", "skipped", "error"] },
    pendingEventCount: { type: "integer", minimum: 0 },
    pendingEventIds: { type: "array", items: { type: "string" } },
    running: { type: "boolean" },
    cooldownUntil: { type: ["string", "null"] },
    lastActivityAt: { type: ["string", "null"] },
    last: { type: ["object", "null"] },
    history: { type: "array" },
    automation: { type: "object" },
  },
};
