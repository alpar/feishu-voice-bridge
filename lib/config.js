"use strict";

const {
  DEFAULT_SCRIPT_PATH,
  DEFAULT_STT_SCRIPT_PATH,
  DEFAULT_VOICE,
  DEFAULT_RATE,
  DEFAULT_PITCH,
  DEFAULT_STT_LANGUAGE,
  DEFAULT_STT_MODEL,
  DEFAULT_VOICE_REPLY_ENABLED,
  DEFAULT_VOICE_REPLY_MODE,
  DEFAULT_VOICE_REPLY_WINDOW_MS,
  DEFAULT_VOICE_REPLY_COOLDOWN_MS,
  DEFAULT_MAX_REPLY_CHARS,
  DEFAULT_VOICE_REPLY_DEBOUNCE_MS,
  DEFAULT_PROMPT_TOOL_TTS_FOR_TEXT,
  DEFAULT_VOICE_REPLY_SUMMARY_ENABLED,
  DEFAULT_VOICE_REPLY_SUMMARY_MAX_SENTENCES,
  DEFAULT_VOICE_REPLY_SUMMARY_JOINER,
  DEFAULT_VOICE_REPLY_SUMMARY_PREFIX,
  DEFAULT_VOICE_REPLY_SUMMARY_SUFFIX,
  DEFAULT_MAX_CAPTURED_REPLY_CHARS
} = require("./constants");

function readPluginStringField(rawConfig, key) {
  return typeof rawConfig?.[key] === "string" && rawConfig[key].trim() ? rawConfig[key].trim() : "";
}

function normalizeRateSetting(value, fallback = DEFAULT_RATE) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().replace(/%$/u, "") || fallback;
}

function normalizePitchSetting(value, fallback = DEFAULT_PITCH) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().replace(/hz$/iu, "") || fallback;
}

function readSpeechField(container, key) {
  return typeof container?.[key] === "string" && container[key].trim()
    ? container[key].trim()
    : "";
}

// 统一收口插件配置，避免后续业务逻辑里反复写兜底判断。
function resolvePluginConfig(api) {
  const rawPluginConfig = api?.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
  const voiceReplyMode = typeof rawPluginConfig.voiceReplyMode === "string"
    ? rawPluginConfig.voiceReplyMode.trim().toLowerCase()
    : DEFAULT_VOICE_REPLY_MODE;
  const normalizedVoiceReplyMode = voiceReplyMode === "always" || voiceReplyMode === "off" || voiceReplyMode === "inbound"
    ? voiceReplyMode
    : DEFAULT_VOICE_REPLY_MODE;
  const voiceReplyEnabled = typeof rawPluginConfig.voiceReplyEnabled === "boolean"
    ? rawPluginConfig.voiceReplyEnabled
    : DEFAULT_VOICE_REPLY_ENABLED;
  const voiceReplyWindowMs = Number.isFinite(Number(rawPluginConfig.voiceReplyWindowMs)) && Number(rawPluginConfig.voiceReplyWindowMs) > 0
    ? Number(rawPluginConfig.voiceReplyWindowMs)
    : DEFAULT_VOICE_REPLY_WINDOW_MS;
  const voiceReplyCooldownMs = Number.isFinite(Number(rawPluginConfig.voiceReplyCooldownMs)) && Number(rawPluginConfig.voiceReplyCooldownMs) > 0
    ? Number(rawPluginConfig.voiceReplyCooldownMs)
    : DEFAULT_VOICE_REPLY_COOLDOWN_MS;
  const maxReplyChars = Number.isFinite(Number(rawPluginConfig.maxReplyChars)) && Number(rawPluginConfig.maxReplyChars) > 0
    ? Number(rawPluginConfig.maxReplyChars)
    : DEFAULT_MAX_REPLY_CHARS;
  const maxCapturedReplyChars = Number.isFinite(Number(rawPluginConfig.maxCapturedReplyChars)) && Number(rawPluginConfig.maxCapturedReplyChars) > 0
    ? Math.max(Number(rawPluginConfig.maxCapturedReplyChars), maxReplyChars, DEFAULT_MAX_CAPTURED_REPLY_CHARS)
    : Math.max(DEFAULT_MAX_CAPTURED_REPLY_CHARS, maxReplyChars);
  const voiceReplyDebounceMs = Number.isFinite(Number(rawPluginConfig.voiceReplyDebounceMs)) && Number(rawPluginConfig.voiceReplyDebounceMs) >= 0
    ? Number(rawPluginConfig.voiceReplyDebounceMs)
    : DEFAULT_VOICE_REPLY_DEBOUNCE_MS;
  const promptToolTtsForText = typeof rawPluginConfig.promptToolTtsForText === "boolean"
    ? rawPluginConfig.promptToolTtsForText
    : DEFAULT_PROMPT_TOOL_TTS_FOR_TEXT;
  const voiceReplySummaryEnabled = typeof rawPluginConfig.voiceReplySummaryEnabled === "boolean"
    ? rawPluginConfig.voiceReplySummaryEnabled
    : DEFAULT_VOICE_REPLY_SUMMARY_ENABLED;
  const voiceReplySummaryMaxSentences = Number.isFinite(Number(rawPluginConfig.voiceReplySummaryMaxSentences)) && Number(rawPluginConfig.voiceReplySummaryMaxSentences) > 0
    ? Number(rawPluginConfig.voiceReplySummaryMaxSentences)
    : DEFAULT_VOICE_REPLY_SUMMARY_MAX_SENTENCES;
  const voiceReplySummaryJoiner = readPluginStringField(rawPluginConfig, "voiceReplySummaryJoiner") || DEFAULT_VOICE_REPLY_SUMMARY_JOINER;
  const voiceReplySummaryPrefix = readPluginStringField(rawPluginConfig, "voiceReplySummaryPrefix") || DEFAULT_VOICE_REPLY_SUMMARY_PREFIX;
  const voiceReplySummarySuffix = readPluginStringField(rawPluginConfig, "voiceReplySummarySuffix") || DEFAULT_VOICE_REPLY_SUMMARY_SUFFIX;
  const tts = {
    scriptPath: readPluginStringField(rawPluginConfig, "scriptPath") || DEFAULT_SCRIPT_PATH,
    defaults: {
      voice: readPluginStringField(rawPluginConfig, "defaultVoice") || DEFAULT_VOICE,
      rate: normalizeRateSetting(readPluginStringField(rawPluginConfig, "defaultRate"), DEFAULT_RATE),
      pitch: normalizePitchSetting(readPluginStringField(rawPluginConfig, "defaultPitch"), DEFAULT_PITCH)
    }
  };
  const stt = {
    scriptPath: readPluginStringField(rawPluginConfig, "sttScriptPath") || DEFAULT_STT_SCRIPT_PATH,
    language: readPluginStringField(rawPluginConfig, "sttLanguage") || DEFAULT_STT_LANGUAGE,
    model: readPluginStringField(rawPluginConfig, "sttModel") || DEFAULT_STT_MODEL
  };
  const voiceReply = {
    enabled: voiceReplyEnabled,
    mode: normalizedVoiceReplyMode,
    promptToolTtsForText,
    timing: {
      windowMs: voiceReplyWindowMs,
      cooldownMs: voiceReplyCooldownMs,
      debounceMs: voiceReplyDebounceMs
    },
    limits: {
      maxReplyChars,
      maxCapturedReplyChars
    },
    summary: {
      enabled: voiceReplySummaryEnabled,
      maxSentences: voiceReplySummaryMaxSentences,
      joiner: voiceReplySummaryJoiner,
      prefix: voiceReplySummaryPrefix,
      suffix: voiceReplySummarySuffix
    }
  };

  return {
    rawPluginConfig,
    gatewayConfig: api?.config && typeof api.config === "object" ? api.config : null,
    tts,
    stt,
    voiceReply,
    scriptPath: tts.scriptPath,
    sttScriptPath: stt.scriptPath,
    defaultVoice: tts.defaults.voice,
    defaultRate: tts.defaults.rate,
    defaultPitch: tts.defaults.pitch,
    sttLanguage: stt.language,
    sttModel: stt.model,
    voiceReplyEnabled,
    voiceReplyMode: normalizedVoiceReplyMode,
    voiceReplyWindowMs,
    voiceReplyCooldownMs,
    maxReplyChars,
    maxCapturedReplyChars,
    voiceReplyDebounceMs,
    promptToolTtsForText,
    voiceReplySummaryEnabled,
    voiceReplySummaryMaxSentences,
    voiceReplySummaryJoiner,
    voiceReplySummaryPrefix,
    voiceReplySummarySuffix,
    runtime: null
  };
}

// TTS 的参数既可能来自插件配置，也可能来自网关或单次请求覆盖，这里统一决策优先级。
function resolveSpeechOptions(config, req) {
  const rawPluginConfig = config.rawPluginConfig || {};
  const requestProviderConfig = req?.providerConfig && typeof req.providerConfig === "object" ? req.providerConfig : {};
  const requestProviderOverrides = req?.providerOverrides && typeof req.providerOverrides === "object" ? req.providerOverrides : {};
  const requestLegacyEdgeConfig = req?.config?.edge && typeof req.config.edge === "object" ? req.config.edge : {};
  const requestLegacyMicrosoftOverrides = req?.overrides?.microsoft && typeof req.overrides.microsoft === "object"
    ? req.overrides.microsoft
    : {};
  const gatewayTtsConfig = config.gatewayConfig?.messages?.tts && typeof config.gatewayConfig.messages.tts === "object"
    ? config.gatewayConfig.messages.tts
    : {};
  const gatewayProviderConfigs = gatewayTtsConfig.providers && typeof gatewayTtsConfig.providers === "object"
    ? gatewayTtsConfig.providers
    : {};
  const gatewayFeishuVoiceConfig = gatewayProviderConfigs["feishu-voice"] && typeof gatewayProviderConfigs["feishu-voice"] === "object"
    ? gatewayProviderConfigs["feishu-voice"]
    : {};
  const gatewayMicrosoftConfig = gatewayProviderConfigs.microsoft && typeof gatewayProviderConfigs.microsoft === "object"
    ? gatewayProviderConfigs.microsoft
    : {};
  const gatewayEdgeConfig = {
    ...gatewayFeishuVoiceConfig,
    ...gatewayMicrosoftConfig,
    ...(gatewayTtsConfig.edge && typeof gatewayTtsConfig.edge === "object" ? gatewayTtsConfig.edge : {}),
    ...(gatewayTtsConfig.microsoft && typeof gatewayTtsConfig.microsoft === "object" ? gatewayTtsConfig.microsoft : {})
  };

  return {
    voice: readPluginStringField(rawPluginConfig, "defaultVoice")
      || readSpeechField(requestProviderOverrides, "voice")
      || readSpeechField(requestProviderOverrides, "voiceId")
      || readSpeechField(requestProviderConfig, "voice")
      || readSpeechField(requestProviderConfig, "voiceId")
      || requestLegacyMicrosoftOverrides.voice
      || requestLegacyEdgeConfig.voice
      || readSpeechField(gatewayFeishuVoiceConfig, "voice")
      || readSpeechField(gatewayFeishuVoiceConfig, "voiceId")
      || readSpeechField(gatewayMicrosoftConfig, "voice")
      || readSpeechField(gatewayMicrosoftConfig, "voiceId")
      || gatewayEdgeConfig.voice
      || config.defaultVoice
      || DEFAULT_VOICE,
    rate: normalizeRateSetting(
      readPluginStringField(rawPluginConfig, "defaultRate")
      || readSpeechField(requestProviderOverrides, "rate")
      || readSpeechField(requestProviderConfig, "rate")
      || requestLegacyEdgeConfig.rate
      || gatewayEdgeConfig.rate,
      config.defaultRate
    ),
    pitch: normalizePitchSetting(
      readPluginStringField(rawPluginConfig, "defaultPitch")
      || readSpeechField(requestProviderOverrides, "pitch")
      || readSpeechField(requestProviderConfig, "pitch")
      || requestLegacyEdgeConfig.pitch
      || gatewayEdgeConfig.pitch,
      config.defaultPitch
    )
  };
}

module.exports = {
  normalizePitchSetting,
  normalizeRateSetting,
  readPluginStringField,
  resolvePluginConfig,
  resolveSpeechOptions
};
