"use strict";

const shared = require("./augment-chat.shared");
const openai = require("./augment-chat.openai");
const anthropic = require("./augment-chat.anthropic");

module.exports = {
  normalizeAugmentChatRequest: shared.normalizeAugmentChatRequest,
  buildSystemPrompt: shared.buildSystemPrompt,
  convertOpenAiTools: shared.convertOpenAiTools,
  convertAnthropicTools: shared.convertAnthropicTools,
  buildToolMetaByName: shared.buildToolMetaByName,
  buildOpenAiMessages: openai.buildOpenAiMessages,
  buildAnthropicMessages: anthropic.buildAnthropicMessages
};

