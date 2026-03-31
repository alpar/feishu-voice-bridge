"use strict";

const { resolvePluginConfig } = require("./lib/config");
const {
  extractAssistantTextFromAgentMessage,
  extractMessageSentText,
  mergeVoiceReplyCandidate,
  prepareVoiceReplyText
} = require("./lib/text");
const { buildMediaUnderstandingProvider, buildProvider } = require("./lib/providers");
const { registerVoiceReplyHooks } = require("./lib/voice-reply-hooks");

// 入口文件只负责组装插件，复杂逻辑拆到 lib/ 下，便于后续单独维护和测试。
const plugin = {
  id: "feishu-voice-bridge",
  name: "飞书语音桥接插件（STT + TTS）",
  description: "OpenClaw 原生飞书语音桥接插件，提供本地 STT、TTS 与官方语音链路兼容能力。",
  register(api) {
    const cfg = resolvePluginConfig(api);
    api.registerSpeechProvider(buildProvider(cfg, api.logger));
    api.registerMediaUnderstandingProvider(buildMediaUnderstandingProvider(cfg, api.logger));
    registerVoiceReplyHooks(api, cfg);
  }
};

module.exports = plugin;
module.exports.default = plugin;
module.exports.__private = {
  extractAssistantTextFromAgentMessage,
  extractMessageSentText,
  mergeVoiceReplyCandidate,
  prepareVoiceReplyText,
  registerVoiceReplyHooks
};
