import { chmod, lstat, open } from "node:fs/promises";
import { ParquetReader, ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";
import type { DatasetExample } from "@trajpack/schema";
import { canonicalJson } from "./canonical.js";

/**
 * Native nested Parquet representation of the public HF conversational view.
 * Arbitrary JSON that cannot be represented by a stable Parquet schema remains
 * in explicitly named JSON sidecars instead of masquerading as nested data.
 */
export const HF_PARQUET_SCHEMA_VERSION = "hf-conversational-parquet/0.2" as const;

const schema = new ParquetSchema({
  id: { type: "UTF8" },
  trace_id: { type: "UTF8" },
  source_event_ids: { type: "UTF8", repeated: true },
  messages: {
    repeated: true,
    fields: {
      role: { type: "UTF8" },
      content: { type: "UTF8", optional: true },
      reasoning_content: { type: "UTF8", optional: true },
      tool_call_id: { type: "UTF8", optional: true },
      name: { type: "UTF8", optional: true },
      event_id: { type: "UTF8", optional: true },
      event_type: { type: "UTF8", optional: true },
      tool_calls: {
        repeated: true,
        fields: {
          id: { type: "UTF8" },
          type: { type: "UTF8" },
          function: {
            fields: {
              name: { type: "UTF8" },
              arguments: { type: "UTF8" },
            },
          },
        },
      },
    },
  },
  tools: {
    repeated: true,
    fields: {
      type: { type: "UTF8" },
      function: {
        fields: {
          name: { type: "UTF8" },
          description: { type: "UTF8", optional: true },
          // JSON Schema is open-ended, so keep only that leaf as an honest
          // sidecar rather than inventing an unstable nested Parquet schema.
          parameters_json: { type: "UTF8" },
        },
      },
    },
  },
  assistant_loss_mask: { type: "BOOLEAN", repeated: true },
  training_targets: {
    repeated: true,
    fields: {
      message_index: { type: "INT64" },
      components: { type: "UTF8", repeated: true },
      loss_weight: { type: "DOUBLE" },
      source_event_ids: { type: "UTF8", repeated: true },
    },
  },
  reward: { type: "DOUBLE", optional: true },
  verifier: {
    optional: true,
    fields: {
      name: { type: "UTF8" },
      version: { type: "UTF8" },
    },
  },
  metadata_json: { type: "UTF8" },
  parquet_schema_version: { type: "UTF8" },
});

function stringValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" ? value : canonicalJson(value);
}

function messageRow(message: Record<string, unknown>): Record<string, unknown> {
  const role = stringValue(message.role);
  if (role === undefined) throw new Error("HF Parquet message is missing role");
  const calls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("HF Parquet tool call must be an object");
      }
      const call = value as Record<string, unknown>;
      const fn = call.function;
      if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
        throw new Error("HF Parquet tool call is missing function");
      }
      const functionRecord = fn as Record<string, unknown>;
      const id = stringValue(call.id);
      const name = stringValue(functionRecord.name);
      if (id === undefined || name === undefined) throw new Error("HF Parquet tool call is missing id or name");
      return {
        id,
        type: stringValue(call.type) ?? "function",
        function: {
          name,
          arguments: stringValue(functionRecord.arguments) ?? "{}",
        },
      };
    })
    : [];
  return {
    role,
    ...(stringValue(message.content) === undefined ? {} : { content: stringValue(message.content) }),
    ...(stringValue(message.reasoning_content) === undefined ? {} : { reasoning_content: stringValue(message.reasoning_content) }),
    ...(stringValue(message.tool_call_id) === undefined ? {} : { tool_call_id: stringValue(message.tool_call_id) }),
    ...(stringValue(message.name) === undefined ? {} : { name: stringValue(message.name) }),
    ...(stringValue(message.event_id) === undefined ? {} : { event_id: stringValue(message.event_id) }),
    ...(stringValue(message.event_type) === undefined ? {} : { event_type: stringValue(message.event_type) }),
    tool_calls: calls,
  };
}

function toolRow(value: Record<string, unknown>): Record<string, unknown> {
  const fn = value.function;
  if (!fn || typeof fn !== "object" || Array.isArray(fn)) throw new Error("HF Parquet tool definition is missing function");
  const functionRecord = fn as Record<string, unknown>;
  const name = stringValue(functionRecord.name);
  if (name === undefined) throw new Error("HF Parquet tool definition is missing name");
  return {
    type: stringValue(value.type) ?? "function",
    function: {
      name,
      ...(stringValue(functionRecord.description) === undefined
        ? {}
        : { description: stringValue(functionRecord.description) }),
      parameters_json: canonicalJson(functionRecord.parameters ?? {}),
    },
  };
}

function auditMessageRow(message: Record<string, unknown>): Record<string, unknown> {
  const row = messageRow(message);
  const calls = row.tool_calls as unknown[];
  return {
    role: row.role,
    content: row.content ?? null,
    reasoning_content: row.reasoning_content ?? null,
    tool_call_id: row.tool_call_id ?? null,
    name: row.name ?? null,
    event_id: row.event_id ?? null,
    event_type: row.event_type ?? null,
    tool_calls: calls.length === 0 ? null : calls,
  };
}

function parquetAuditRow(example: DatasetExample): Record<string, unknown> {
  const tools = example.tools.map(toolRow);
  const targets = example.training_targets.map((target) => ({
    message_index: target.message_index,
    components: target.components.length === 0 ? null : target.components,
    loss_weight: target.loss_weight,
    source_event_ids: target.source_event_ids.length === 0 ? null : target.source_event_ids,
  }));
  return {
    id: example.id,
    trace_id: example.trace_id,
    source_event_ids: example.source_event_ids.length === 0 ? null : example.source_event_ids,
    messages: example.messages.length === 0 ? null : example.messages.map(auditMessageRow),
    tools: tools.length === 0 ? null : tools,
    assistant_loss_mask: example.assistant_loss_mask.length === 0 ? null : example.assistant_loss_mask,
    training_targets: targets.length === 0 ? null : targets,
    reward: example.reward,
    verifier: example.verifier,
    metadata_json: canonicalJson(example.metadata),
    parquet_schema_version: HF_PARQUET_SCHEMA_VERSION,
  };
}

function normalizeReaderValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error("HF Parquet contains an unsafe INT64 value");
    return number;
  }
  if (Array.isArray(value)) return value.map(normalizeReaderValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, normalizeReaderValue(child)]));
  }
  return value;
}

/**
 * Compare the complete native Parquet training rows with their canonical JSONL
 * examples. The return values are stable mismatch labels suitable for the
 * dataset validator; malformed or oversized Parquet fails closed.
 */
export async function validateHfParquetFile(
  path: string,
  examples: DatasetExample[],
  maxBytes = 512 * 1024 * 1024,
): Promise<string[]> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > maxBytes) {
    throw new Error(`Invalid or oversized HF Parquet artifact: ${path}`);
  }
  const expected = new Map(examples.map((example) => [example.id, canonicalJson(parquetAuditRow(example))]));
  if (expected.size !== examples.length) throw new Error("HF JSONL contains duplicate example ids");
  const observed = new Set<string>();
  const mismatches: string[] = [];
  const reader = await ParquetReader.openFile(path);
  try {
    const cursor = reader.getCursor();
    let row: Record<string, unknown> | null;
    while ((row = await cursor.next() as Record<string, unknown> | null) !== null) {
      if (typeof row.id !== "string") throw new Error("HF Parquet row is missing an id");
      if (observed.has(row.id)) throw new Error("HF Parquet contains duplicate example ids");
      observed.add(row.id);
      const expectedRow = expected.get(row.id);
      if (expectedRow === undefined) mismatches.push(`unexpected:${row.id}`);
      else if (canonicalJson(normalizeReaderValue(row)) !== expectedRow) mismatches.push(`row:${row.id}`);
    }
  } finally {
    await reader.close();
  }
  for (const id of expected.keys()) if (!observed.has(id)) mismatches.push(`missing:${id}`);
  return mismatches.sort();
}

export async function writeHfParquet(path: string, examples: Iterable<DatasetExample>): Promise<void> {
  // parquetjs truncates its target. Reserve it first with private permissions so
  // no plaintext Parquet file is ever briefly created with ambient defaults.
  const placeholder = await open(path, "wx", 0o600);
  await placeholder.close();
  const writer = await ParquetWriter.openFile(schema, path);
  try {
    for (const example of examples) {
      await writer.appendRow({
        id: example.id,
        trace_id: example.trace_id,
        source_event_ids: example.source_event_ids,
        messages: example.messages.map(messageRow),
        tools: example.tools.map(toolRow),
        assistant_loss_mask: example.assistant_loss_mask,
        training_targets: example.training_targets.map((target) => ({
          message_index: target.message_index,
          components: target.components,
          loss_weight: target.loss_weight,
          source_event_ids: target.source_event_ids,
        })),
        ...(example.reward === null ? {} : { reward: example.reward }),
        ...(example.verifier === null ? {} : { verifier: example.verifier }),
        metadata_json: canonicalJson(example.metadata),
        parquet_schema_version: HF_PARQUET_SCHEMA_VERSION,
      });
    }
  } finally {
    await writer.close();
  }
  await chmod(path, 0o600);
}
