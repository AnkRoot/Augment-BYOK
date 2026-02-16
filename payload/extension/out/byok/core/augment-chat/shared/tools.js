"use strict";

const { normalizeString } = require("../../../infra/util");
const { asRecord, asArray, asString, pick } = require("../../augment-struct");

function normalizeToolDefinitions(raw) {
  const list = asArray(raw);
  const out = [];
  for (const it of list) {
    const r = asRecord(it);
    const name = normalizeString(pick(r, ["name"]));
    if (!name) continue;
    const description = asString(pick(r, ["description"])) || "";
    const input_schema = pick(r, ["input_schema", "inputSchema"]);
    const input_schema_json = asString(pick(r, ["input_schema_json", "inputSchemaJson"])) || "";
    const mcp_server_name = asString(pick(r, ["mcp_server_name", "mcpServerName"])) || "";
    const mcp_tool_name = asString(pick(r, ["mcp_tool_name", "mcpToolName"])) || "";
    out.push({ name, description, input_schema: input_schema && typeof input_schema === "object" ? input_schema : null, input_schema_json, mcp_server_name, mcp_tool_name });
  }
  return out;
}

function resolveToolSchema(def) {
  if (def && def.input_schema && typeof def.input_schema === "object" && !Array.isArray(def.input_schema)) return def.input_schema;
  const raw = normalizeString(def && def.input_schema_json);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return { type: "object", properties: {} };
}

function coerceOpenAiStrictJsonSchema(schema, depth) {
  const d = Number.isFinite(Number(depth)) ? Number(depth) : 0;
  if (d > 50) return schema;
  if (Array.isArray(schema)) return schema.map((x) => coerceOpenAiStrictJsonSchema(x, d + 1));
  if (!schema || typeof schema !== "object") return schema;

  const out = { ...schema };

  const t = out.type;
  const hasObjectType = t === "object" || (Array.isArray(t) && t.some((x) => normalizeString(x).toLowerCase() === "object"));
  const hasProps = out.properties && typeof out.properties === "object" && !Array.isArray(out.properties);
  if (hasObjectType || hasProps) {
    if (!hasObjectType) out.type = "object";
    if (!hasProps) out.properties = {};
    out.additionalProperties = false;
    const props = out.properties && typeof out.properties === "object" && !Array.isArray(out.properties) ? out.properties : {};
    out.properties = props;
    // OpenAI Responses strict schema: required 必须覆盖全部 properties。
    out.required = Object.keys(props);
  }

  if (out.properties && typeof out.properties === "object" && !Array.isArray(out.properties)) {
    const props = out.properties;
    const next = {};
    for (const k of Object.keys(props)) next[k] = coerceOpenAiStrictJsonSchema(props[k], d + 1);
    out.properties = next;
  }

  if (out.items != null) out.items = coerceOpenAiStrictJsonSchema(out.items, d + 1);
  if (out.prefixItems != null) out.prefixItems = coerceOpenAiStrictJsonSchema(out.prefixItems, d + 1);
  if (out.additionalProperties != null && out.additionalProperties !== false) out.additionalProperties = false;

  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map((x) => coerceOpenAiStrictJsonSchema(x, d + 1));
  if (Array.isArray(out.oneOf)) out.oneOf = out.oneOf.map((x) => coerceOpenAiStrictJsonSchema(x, d + 1));
  if (Array.isArray(out.allOf)) out.allOf = out.allOf.map((x) => coerceOpenAiStrictJsonSchema(x, d + 1));
  if (out.not != null) out.not = coerceOpenAiStrictJsonSchema(out.not, d + 1);

  if (out.$defs && typeof out.$defs === "object" && !Array.isArray(out.$defs)) {
    const defs = out.$defs;
    const next = {};
    for (const k of Object.keys(defs)) next[k] = coerceOpenAiStrictJsonSchema(defs[k], d + 1);
    out.$defs = next;
  }
  if (out.definitions && typeof out.definitions === "object" && !Array.isArray(out.definitions)) {
    const defs = out.definitions;
    const next = {};
    for (const k of Object.keys(defs)) next[k] = coerceOpenAiStrictJsonSchema(defs[k], d + 1);
    out.definitions = next;
  }

  return out;
}

function convertOpenAiTools(toolDefs) {
  const defs = normalizeToolDefinitions(toolDefs);
  return defs.map((d) => ({ type: "function", function: { name: d.name, ...(normalizeString(d.description) ? { description: d.description } : {}), parameters: resolveToolSchema(d) } }));
}

function convertAnthropicTools(toolDefs) {
  const defs = normalizeToolDefinitions(toolDefs);
  return defs.map((d) => ({ name: d.name, ...(normalizeString(d.description) ? { description: d.description } : {}), input_schema: resolveToolSchema(d) }));
}

function convertGeminiTools(toolDefs) {
  const defs = normalizeToolDefinitions(toolDefs);
  const decls = defs.map((d) => ({ name: d.name, ...(normalizeString(d.description) ? { description: d.description } : {}), parameters: resolveToolSchema(d) }));
  if (!decls.length) return [];
  return [{ functionDeclarations: decls }];
}

function convertOpenAiResponsesTools(toolDefs) {
  const defs = normalizeToolDefinitions(toolDefs);
  return defs.map((d) => ({
    type: "function",
    name: d.name,
    parameters: coerceOpenAiStrictJsonSchema(resolveToolSchema(d)),
    strict: true,
    ...(normalizeString(d.description) ? { description: d.description } : {})
  }));
}

function buildToolMetaByName(toolDefs) {
  const defs = normalizeToolDefinitions(toolDefs);
  const map = new Map();
  for (const d of defs) {
    const toolName = normalizeString(d.name);
    if (!toolName) continue;
    const mcpServerName = normalizeString(d.mcp_server_name);
    const mcpToolName = normalizeString(d.mcp_tool_name);
    if (!mcpServerName && !mcpToolName) continue;
    map.set(toolName, { mcpServerName: mcpServerName || undefined, mcpToolName: mcpToolName || undefined });
  }
  return map;
}

module.exports = {
  normalizeToolDefinitions,
  resolveToolSchema,
  coerceOpenAiStrictJsonSchema,
  convertOpenAiTools,
  convertAnthropicTools,
  convertGeminiTools,
  convertOpenAiResponsesTools,
  buildToolMetaByName
};
