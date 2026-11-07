import test from "node:test";
import assert from "node:assert/strict";
import * as z from "zod/v4";
import { createProposalSchema } from "../../../src/domain/research/changes/proposals.js";
import { compactSchemaOutput } from "../../../src/domain/research/interfaces/schema-output.js";

function expand(value, root) {
  if (Array.isArray(value)) return value.map((item) => expand(item, root));
  if (!value || typeof value !== "object") return value;
  if (value.$ref) {
    assert.match(value.$ref, /^#\//);
    const target = value.$ref
      .slice(2)
      .split("/")
      .reduce(
        (object, key) => object?.[key.replace(/~1/g, "/").replace(/~0/g, "~")],
        root,
      );
    assert.ok(target, "Every schema reference resolves");
    return expand(target, root);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !["$defs", "$schema", "description", "title", "examples"].includes(
            key,
          ),
      )
      .map(([key, item]) => [
        key,
        ["const", "enum", "default"].includes(key) ? item : expand(item, root),
      ]),
  );
}

test("the complete proposal contract stays within the schema budget without changing validation constraints", () => {
  const schema = z.toJSONSchema(createProposalSchema, { reused: "ref" }),
    compact = compactSchemaOutput(schema);
  assert.deepEqual(expand(compact, compact), expand(schema, schema));
  assert.ok(JSON.stringify(compact).length < 15000);
});

test("schema definition compaction preserves escaped references and unrelated enum values", () => {
  const schema = {
    type: "object",
    properties: {
      run: { $ref: "#/$defs/A~1B" },
      label: { enum: ["A/B", "__schema0"] },
      literal: { const: { $ref: "#/$defs/A~1B", title: "Retained user data" } },
    },
    $defs: { "A/B": { type: "string", minLength: 1 } },
  };
  const compact = compactSchemaOutput(schema);
  assert.deepEqual(expand(compact, compact), expand(schema, schema));
  assert.deepEqual(compact.properties.label.enum, ["A/B", "__schema0"]);
  assert.deepEqual(
    compact.properties.literal.const,
    schema.properties.literal.const,
  );
});
