"use strict";

const { normalizeString, normalizeRawToken } = require("../../infra/util");
const { completeAugmentChatTextByProviderType } = require("../provider-augment-chat");

function normalizeProviderRequestDefaults(provider, maxTokens) {
  const base =
    provider && typeof provider === "object" && provider.requestDefaults && typeof provider.requestDefaults === "object" && !Array.isArray(provider.requestDefaults)
      ? provider.requestDefaults
      : {};
  const out = { ...base };
  const type = normalizeString(provider?.type);
  const mt = Number(maxTokens);
  const hasMt = Number.isFinite(mt) && mt > 0;
  if (hasMt) {
    const n = Math.floor(mt);
    if (type === "openai_responses") {
      out.max_output_tokens = n;
      if ("max_tokens" in out) delete out.max_tokens;
      if ("maxTokens" in out) delete out.maxTokens;
    } else if (type === "gemini_ai_studio") {
      const gc = out.generationConfig && typeof out.generationConfig === "object" && !Array.isArray(out.generationConfig) ? out.generationConfig : {};
      out.generationConfig = { ...gc, maxOutputTokens: n };
      if ("max_tokens" in out) delete out.max_tokens;
      if ("maxTokens" in out) delete out.maxTokens;
    } else {
      out.max_tokens = n;
    }
  }
  if (out.thinking) delete out.thinking;
  if (out.reasoning) delete out.reasoning;
  if (out.reasoning_effort) delete out.reasoning_effort;
  if (out.reasoningEffort) delete out.reasoningEffort;
  if (out.tools) delete out.tools;
  if (out.tool_choice) delete out.tool_choice;
  if (out.toolChoice) delete out.toolChoice;
  return out;
}

async function runSummaryModelOnce({ provider, model, prompt, chatHistory, maxTokens, timeoutMs, abortSignal }) {
  const p = provider && typeof provider === "object" ? provider : null;
  const type = normalizeString(p?.type);
  const baseUrl = normalizeString(p?.baseUrl);
  const apiKey = normalizeRawToken(p?.apiKey);
  const extraHeaders = p?.headers && typeof p.headers === "object" && !Array.isArray(p.headers) ? p.headers : {};
  const requestDefaults = normalizeProviderRequestDefaults(p, maxTokens);
  if (!type || !baseUrl || !normalizeString(model)) throw new Error("historySummary provider/model 未配置");
  if (!apiKey && Object.keys(extraHeaders).length === 0) throw new Error("historySummary provider 未配置 api_key（且 headers 为空）");
  if (!normalizeString(prompt) || !Array.isArray(chatHistory) || !chatHistory.length) throw new Error("historySummary prompt/chatHistory 为空");

  const augmentReq = {
    message: prompt,
    conversation_id: "",
    chat_history: chatHistory,
    tool_definitions: [],
    nodes: [],
    structured_request_nodes: [],
    request_nodes: [],
    agent_memories: "",
    mode: "",
    prefix: "",
    suffix: "",
    lang: "",
    path: "",
    user_guidelines: "",
    workspace_guidelines: "",
    rules: null,
    feature_detection_flags: {}
  };

  return await completeAugmentChatTextByProviderType({
    type,
    baseUrl,
    apiKey,
    model,
    req: augmentReq,
    timeoutMs,
    abortSignal,
    extraHeaders,
    requestDefaults
  });
}

module.exports = { normalizeProviderRequestDefaults, runSummaryModelOnce };
