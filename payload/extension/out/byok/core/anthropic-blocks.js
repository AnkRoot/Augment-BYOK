"use strict";

const { normalizeString } = require("../infra/util");
const { truncateText } = require("../infra/text");

function normalizeAnthropicBlocks(content) {
  if (Array.isArray(content)) return content.filter((b) => b && typeof b === "object");
  if (typeof content === "string" && content) return [{ type: "text", text: content }];
  return [];
}

function stringifyAnthropicToolResultContent(content) {
  if (typeof content === "string") return content;
  const blocks = Array.isArray(content) ? content : [];
  const parts = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image") parts.push("[image omitted]");
    else parts.push(`[${normalizeString(b.type) || "content"} omitted]`);
  }
  return parts.join("");
}

function buildOrphanAnthropicToolResultAsTextBlock(block, opts) {
  const maxLen = Number.isFinite(Number(opts?.maxOrphanContentLen)) ? Number(opts.maxOrphanContentLen) : 8000;
  const id = normalizeString(block?.tool_use_id);
  const content = truncateText(stringifyAnthropicToolResultContent(block?.content), maxLen).trim();
  const header = id ? `[orphan_tool_result tool_use_id=${id}]` : "[orphan_tool_result]";
  return { type: "text", text: content ? `${header}\n${content}` : header };
}

function stripAnthropicToolBlocksFromMessages(messages, opts) {
  const maxLen = Number.isFinite(Number(opts?.maxToolTextLen)) ? Math.floor(Number(opts.maxToolTextLen)) : 8000;
  const input = Array.isArray(messages) ? messages : [];
  const out = [];
  for (const msg of input) {
    const content = msg?.content;
    if (!Array.isArray(content)) {
      out.push(msg);
      continue;
    }

    const blocks = content.filter((b) => b && typeof b === "object");
    if (!blocks.length) {
      out.push(msg);
      continue;
    }

    const rewritten = [];
    let changed = false;
    for (const b of blocks) {
      const t = normalizeString(b.type);
      if (t === "tool_use") {
        const name = normalizeString(b.name);
        const id = normalizeString(b.id);
        const inputText =
          b.input && typeof b.input === "object" && !Array.isArray(b.input) ? truncateText(JSON.stringify(b.input), maxLen) : "";
        const header = `[tool_use${name ? ` name=${name}` : ""}${id ? ` id=${id}` : ""}]`;
        const text = inputText ? `${header}\n${inputText}` : header;
        rewritten.push({ type: "text", text });
        changed = true;
        continue;
      }
      if (t === "tool_result") {
        const id = normalizeString(b.tool_use_id);
        const isErr = Boolean(b.is_error);
        const header = `[tool_result${id ? ` tool_use_id=${id}` : ""}${isErr ? " is_error=true" : ""}]`;
        const contentText = truncateText(stringifyAnthropicToolResultContent(b.content), maxLen).trim();
        const text = contentText ? `${header}\n${contentText}` : header;
        rewritten.push({ type: "text", text });
        changed = true;
        continue;
      }
      rewritten.push(b);
    }
    out.push(changed ? { ...msg, content: rewritten } : msg);
  }
  return out;
}

module.exports = {
  normalizeAnthropicBlocks,
  stringifyAnthropicToolResultContent,
  buildOrphanAnthropicToolResultAsTextBlock,
  stripAnthropicToolBlocksFromMessages
};

