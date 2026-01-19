"use strict";

const { normalizeString } = require("../infra/util");
const { truncateText } = require("../infra/text");
const { normalizeAnthropicBlocks, buildOrphanAnthropicToolResultAsTextBlock } = require("./anthropic-blocks");

const TOOL_RESULT_MISSING_MESSAGE =
  "未收到对应的 tool_result（可能是工具未执行/被禁用/权限不足/或历史中丢失）。请在缺失结果的前提下继续推理或改为不依赖该工具。";

function normalizeRole(v) {
  return normalizeString(v).toLowerCase();
}

function normalizeToolCall(tc) {
  const rec = tc && typeof tc === "object" ? tc : {};
  const fn = rec.function && typeof rec.function === "object" ? rec.function : {};
  const id = normalizeString(rec.id);
  if (!id) return null;
  return {
    id,
    name: normalizeString(fn.name),
    arguments: typeof fn.arguments === "string" ? fn.arguments : ""
  };
}

function buildMissingToolResultContent(tc, opts) {
  const maxArgsLen = Number.isFinite(Number(opts?.maxArgsLen)) ? Number(opts.maxArgsLen) : 4000;
  const payload = {
    error: "tool_result_missing",
    tool_call_id: normalizeString(tc?.id),
    tool_name: normalizeString(tc?.name) || undefined,
    message: TOOL_RESULT_MISSING_MESSAGE
  };
  const args = normalizeString(tc?.arguments);
  if (args) payload.arguments = truncateText(args, maxArgsLen);
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload.message || "tool_result_missing");
  }
}

function buildOrphanToolResultAsUserContent(msg, opts) {
  const maxLen = Number.isFinite(Number(opts?.maxOrphanContentLen)) ? Number(opts.maxOrphanContentLen) : 8000;
  const id = normalizeString(msg?.tool_call_id);
  const content = truncateText(typeof msg?.content === "string" ? msg.content : String(msg?.content ?? ""), maxLen).trim();
  const header = id ? `[orphan_tool_result tool_call_id=${id}]` : "[orphan_tool_result]";
  return content ? `${header}\n${content}` : header;
}

function repairOpenAiToolCallPairs(messages, opts) {
  const input = Array.isArray(messages) ? messages : [];
  const out = [];

  const report = {
    injected_missing_tool_results: 0,
    converted_orphan_tool_results: 0
  };

  let pending = null; // Map<string, {id,name,arguments}>
  let bufferedOrphanToolMessages = null; // Array<msg>

  const injectMissing = () => {
    if (!pending || pending.size === 0) {
      pending = null;
      return;
    }
    for (const tc of pending.values()) {
      out.push({ role: "tool", tool_call_id: tc.id, content: buildMissingToolResultContent(tc, opts) });
      report.injected_missing_tool_results += 1;
    }
    pending = null;
  };

  const handleOrphanTool = (msg) => {
    out.push({ role: "user", content: buildOrphanToolResultAsUserContent(msg, opts) });
    report.converted_orphan_tool_results += 1;
  };

  const bufferOrphanTool = (msg) => {
    if (!bufferedOrphanToolMessages) bufferedOrphanToolMessages = [];
    bufferedOrphanToolMessages.push(msg);
  };

  const flushBufferedOrphans = () => {
    if (!bufferedOrphanToolMessages || bufferedOrphanToolMessages.length === 0) {
      bufferedOrphanToolMessages = null;
      return;
    }
    for (const msg of bufferedOrphanToolMessages) handleOrphanTool(msg);
    bufferedOrphanToolMessages = null;
  };

  const closePendingToolPhase = () => {
    injectMissing();
    flushBufferedOrphans();
  };

  for (const msg of input) {
    const role = normalizeRole(msg?.role);

    if (pending) {
      if (role === "tool") {
        const id = normalizeString(msg?.tool_call_id);
        if (id && pending.has(id)) {
          pending.delete(id);
          out.push(msg);
          if (pending.size === 0) {
            pending = null;
            flushBufferedOrphans();
          }
        } else {
          // tool_result 没有匹配到任何待处理 tool_calls；
          // 不能直接转换为 user 并插入（会打断 assistant(tool_calls)->tool 的强制相邻约束），先缓冲，等 pending 结束再处理。
          bufferOrphanTool(msg);
        }
        continue;
      }

      // 遇到非 tool 消息，说明 tool_result 阶段已结束；把缺失的补齐到当前消息之前，保证顺序合法
      closePendingToolPhase();
      // 继续处理当前消息（fallthrough）
    }

    if (role === "assistant" && Array.isArray(msg?.tool_calls) && msg.tool_calls.length) {
      out.push(msg);
      const m = new Map();
      for (const raw of msg.tool_calls) {
        const tc = normalizeToolCall(raw);
        if (!tc) continue;
        if (m.has(tc.id)) continue;
        m.set(tc.id, tc);
      }
      pending = m.size ? m : null;
      bufferedOrphanToolMessages = null;
      continue;
    }

    if (role === "tool") {
      // 没有任何 pending tool_calls 的情况下出现 tool 消息，属于 orphan
      handleOrphanTool(msg);
      continue;
    }

    out.push(msg);
  }

  closePendingToolPhase();
  return { messages: out, report };
}

function normalizeItemType(item) {
  const t = normalizeString(item?.type).toLowerCase();
  return t || "message";
}

function normalizeCallId(v) {
  return normalizeString(v);
}

function normalizeFunctionCall(item) {
  const call_id = normalizeCallId(item?.call_id);
  if (!call_id) return null;
  return { call_id, name: normalizeString(item?.name), arguments: typeof item?.arguments === "string" ? item.arguments : "" };
}

function buildMissingOpenAiResponsesToolResultOutput(tc, opts) {
  const maxArgsLen = Number.isFinite(Number(opts?.maxArgsLen)) ? Number(opts.maxArgsLen) : 4000;
  const payload = {
    error: "tool_result_missing",
    call_id: normalizeCallId(tc?.call_id),
    tool_name: normalizeString(tc?.name) || undefined,
    message: TOOL_RESULT_MISSING_MESSAGE
  };
  const args = normalizeString(tc?.arguments);
  if (args) payload.arguments = truncateText(args, maxArgsLen);
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload.message || "tool_result_missing");
  }
}

function buildOrphanOpenAiResponsesToolResultAsUserMessage(item, opts) {
  const maxLen = Number.isFinite(Number(opts?.maxOrphanContentLen)) ? Number(opts.maxOrphanContentLen) : 8000;
  const callId = normalizeCallId(item?.call_id);
  const out = item?.output;
  const content = truncateText(typeof out === "string" ? out : JSON.stringify(out ?? null), maxLen).trim();
  const header = callId ? `[orphan_function_call_output call_id=${callId}]` : "[orphan_function_call_output]";
  return { type: "message", role: "user", content: content ? `${header}\n${content}` : header };
}

function repairOpenAiResponsesToolCallPairs(inputItems, opts) {
  const input = Array.isArray(inputItems) ? inputItems : [];
  const out = [];

  const report = {
    injected_missing_tool_results: 0,
    converted_orphan_tool_results: 0
  };

  let pending = null; // Map<string, {call_id,name,arguments}>
  let bufferedOrphanOutputs = null; // Array<item>

  const injectMissing = () => {
    if (!pending || pending.size === 0) {
      pending = null;
      return;
    }
    for (const tc of pending.values()) {
      out.push({ type: "function_call_output", call_id: tc.call_id, output: buildMissingOpenAiResponsesToolResultOutput(tc, opts) });
      report.injected_missing_tool_results += 1;
    }
    pending = null;
  };

  const bufferOrphanOutput = (item) => {
    if (!bufferedOrphanOutputs) bufferedOrphanOutputs = [];
    bufferedOrphanOutputs.push(item);
  };

  const flushBufferedOrphans = () => {
    if (!bufferedOrphanOutputs || bufferedOrphanOutputs.length === 0) {
      bufferedOrphanOutputs = null;
      return;
    }
    for (const item of bufferedOrphanOutputs) {
      out.push(buildOrphanOpenAiResponsesToolResultAsUserMessage(item, opts));
      report.converted_orphan_tool_results += 1;
    }
    bufferedOrphanOutputs = null;
  };

  const closePendingToolPhase = () => {
    injectMissing();
    flushBufferedOrphans();
  };

  for (const item of input) {
    const type = normalizeItemType(item);

    if (pending) {
      if (type === "function_call") {
        out.push(item);
        const tc = normalizeFunctionCall(item);
        if (tc && !pending.has(tc.call_id)) pending.set(tc.call_id, tc);
        continue;
      }
      if (type === "function_call_output") {
        const callId = normalizeCallId(item?.call_id);
        if (callId && pending.has(callId)) {
          pending.delete(callId);
          out.push(item);
          if (pending.size === 0) {
            pending = null;
            flushBufferedOrphans();
          }
        } else {
          // 同 OpenAI chat：pending 存在时不能插入非 function_call_output（会打断严格配对），先缓冲
          bufferOrphanOutput(item);
        }
        continue;
      }

      closePendingToolPhase();
      // fallthrough
    }

    if (type === "function_call") {
      out.push(item);
      if (!pending) pending = new Map();
      const tc = normalizeFunctionCall(item);
      if (tc && !pending.has(tc.call_id)) pending.set(tc.call_id, tc);
      bufferedOrphanOutputs = null;
      continue;
    }
    if (type === "function_call_output") {
      out.push(buildOrphanOpenAiResponsesToolResultAsUserMessage(item, opts));
      report.converted_orphan_tool_results += 1;
      continue;
    }

    out.push(item);
  }

  closePendingToolPhase();
  return { input: out, report };
}

function buildMissingAnthropicToolResultBlock({ toolUseId, toolName, input } = {}) {
  const payload = {
    error: "tool_result_missing",
    tool_use_id: String(toolUseId || ""),
    tool_name: normalizeString(toolName) || undefined,
    message: TOOL_RESULT_MISSING_MESSAGE
  };
  if (input && typeof input === "object" && !Array.isArray(input)) payload.input = input;
  let content;
  try {
    content = JSON.stringify(payload);
  } catch {
    content = String(payload.message || "tool_result_missing");
  }
  return { type: "tool_result", tool_use_id: String(toolUseId || ""), content, is_error: true };
}

function repairAnthropicToolUsePairs(messages, opts) {
  const input = Array.isArray(messages) ? messages : [];
  const out = [];

  const report = {
    injected_missing_tool_results: 0,
    converted_orphan_tool_results: 0
  };

  let pending = null; // Map<string, {toolUseId, toolName, input}>

  const injectMissing = () => {
    if (!pending || pending.size === 0) {
      pending = null;
      return;
    }
    const blocks = [];
    for (const tc of pending.values()) {
      blocks.push(buildMissingAnthropicToolResultBlock({ toolUseId: tc.toolUseId, toolName: tc.toolName, input: tc.input }));
      report.injected_missing_tool_results += 1;
    }
    out.push({ role: "user", content: blocks });
    pending = null;
  };

  for (const msg of input) {
    const role = normalizeRole(msg?.role);

    if (pending) {
      if (role === "user") {
        const blocks = normalizeAnthropicBlocks(msg?.content);
        const hasToolResult = blocks.some((b) => b && b.type === "tool_result");
        if (!hasToolResult) {
          injectMissing();
          out.push(msg);
          continue;
        }

        const newBlocks = [];
        let changed = false;
        for (const b of blocks) {
          if (b.type === "tool_result") {
            const id = normalizeString(b.tool_use_id);
            if (id && pending.has(id)) {
              pending.delete(id);
              newBlocks.push(b);
            } else {
              newBlocks.push(buildOrphanAnthropicToolResultAsTextBlock(b, opts));
              report.converted_orphan_tool_results += 1;
              changed = true;
            }
          } else newBlocks.push(b);
        }

        // 保证：紧随 tool_use 的这一条 user 消息中包含所有 pending 的 tool_result；
        // 否则某些上游会认为 tool_use 没有被正确回填而报错。
        if (pending.size) {
          for (const tc of pending.values()) {
            newBlocks.push(buildMissingAnthropicToolResultBlock({ toolUseId: tc.toolUseId, toolName: tc.toolName, input: tc.input }));
            report.injected_missing_tool_results += 1;
          }
          pending = null;
          changed = true;
        } else if (pending.size === 0) {
          pending = null;
        }

        out.push(changed ? { ...msg, content: newBlocks } : msg);
        continue;
      }

      // 遇到非 user（通常是 assistant），说明 tool_result 阶段已结束；把缺失的补齐到当前消息之前
      injectMissing();
      // fallthrough 继续处理当前消息
    }

    if (role === "assistant") {
      out.push(msg);
      const blocks = normalizeAnthropicBlocks(msg?.content);
      const toolUses = blocks.filter((b) => b && b.type === "tool_use" && normalizeString(b.id) && normalizeString(b.name));
      if (toolUses.length) {
        const m = new Map();
        for (const b of toolUses) {
          const toolUseId = normalizeString(b.id);
          if (m.has(toolUseId)) continue;
          m.set(toolUseId, { toolUseId, toolName: normalizeString(b.name), input: b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : undefined });
        }
        pending = m.size ? m : null;
      }
      continue;
    }

    if (role === "user") {
      const blocks = normalizeAnthropicBlocks(msg?.content);
      const hasOrphanToolResult = blocks.some((b) => b && b.type === "tool_result");
      if (hasOrphanToolResult) {
        const newBlocks = [];
        for (const b of blocks) {
          if (b && b.type === "tool_result") {
            newBlocks.push(buildOrphanAnthropicToolResultAsTextBlock(b, opts));
            report.converted_orphan_tool_results += 1;
          } else newBlocks.push(b);
        }
        out.push({ ...msg, content: newBlocks });
      } else out.push(msg);
      continue;
    }

    out.push(msg);
  }

  injectMissing();
  return { messages: out, report };
}

module.exports = { TOOL_RESULT_MISSING_MESSAGE, repairOpenAiToolCallPairs, repairOpenAiResponsesToolCallPairs, repairAnthropicToolUsePairs };
