"use strict";

const os = require("node:os");
const path = require("node:path");

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
  DEFAULT_VOICE_REPLY_TEXT_SENDING_FALLBACK_MS,
  DEFAULT_VOICE_REPLY_NO_TEXT_FALLBACK_MS,
  DEFAULT_VOICE_REPLY_ASSISTANT_SETTLE_MS,
  DEFAULT_VOICE_REPLY_RETRY_COUNT,
  DEFAULT_VOICE_REPLY_RETRY_BACKOFF_MS,
  DEFAULT_PROMPT_TOOL_TTS_FOR_TEXT,
  DEFAULT_ENABLE_BEFORE_AGENT_REPLY,
  DEFAULT_VOICE_REPLY_SUMMARY_ENABLED,
  DEFAULT_VOICE_REPLY_SUMMARY_MAX_SENTENCES,
  DEFAULT_VOICE_REPLY_SUMMARY_JOINER,
  DEFAULT_VOICE_REPLY_SUMMARY_PREFIX,
  DEFAULT_VOICE_REPLY_SUMMARY_SUFFIX,
  DEFAULT_MAX_CAPTURED_REPLY_CHARS
} = require("./constants");

const TRUSTED_SCRIPT_ROOTS = [
  path.resolve(path.join(__dirname, "..")),
  path.resolve(path.join(os.homedir(), ".openclaw"))
];

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

function isPathInsideRoot(filePath, rootPath) {
  const relativePath = path.relative(rootPath, filePath);
  return relativePath === ""
    || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeConfiguredScriptPath(rawPath, fallbackPath, securityWarnings, label) {
  const candidatePath = typeof rawPath === "string" && rawPath.trim()
    ? path.resolve(rawPath.trim())
    : path.resolve(fallbackPath);

  const isTrusted = TRUSTED_SCRIPT_ROOTS.some((rootPath) => isPathInsideRoot(candidatePath, rootPath));
  if (isTrusted) return candidatePath;

  securityWarnings.push(`${label} path rejected; fallback to bundled script`);
  return path.resolve(fallbackPath);
}

// 统一收口插件配置，避免后续业务逻辑里反复写兜底判断。
function resolvePluginConfig(api) {
  const rawPluginConfig = api?.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
  const securityWarnings = [];
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
  const voiceReplyTextSendingFallbackMs = Number.isFinite(Number(rawPluginConfig.voiceReplyTextSendingFallbackMs))
    && Number(rawPluginConfig.voiceReplyTextSendingFallbackMs) >= 0
    ? Number(rawPluginConfig.voiceReplyTextSendingFallbackMs)
    : DEFAULT_VOICE_REPLY_TEXT_SENDING_FALLBACK_MS;
  const voiceReplyNoTextFallbackMs = Number.isFinite(Number(rawPluginConfig.voiceReplyNoTextFallbackMs))
    && Number(rawPluginConfig.voiceReplyNoTextFallbackMs) >= 0
    ? Number(rawPluginConfig.voiceReplyNoTextFallbackMs)
    : DEFAULT_VOICE_REPLY_NO_TEXT_FALLBACK_MS;
  const voiceReplyAssistantSettleMs = Number.isFinite(Number(rawPluginConfig.voiceReplyAssistantSettleMs))
    && Number(rawPluginConfig.voiceReplyAssistantSettleMs) >= 0
    ? Number(rawPluginConfig.voiceReplyAssistantSettleMs)
    : DEFAULT_VOICE_REPLY_ASSISTANT_SETTLE_MS;
  const voiceReplyRetryCount = Number.isFinite(Number(rawPluginConfig.voiceReplyRetryCount)) && Number(rawPluginConfig.voiceReplyRetryCount) >= 0
    ? Number(rawPluginConfig.voiceReplyRetryCount)
    : DEFAULT_VOICE_REPLY_RETRY_COUNT;
  const voiceReplyRetryBackoffMs = Number.isFinite(Number(rawPluginConfig.voiceReplyRetryBackoffMs)) && Number(rawPluginConfig.voiceReplyRetryBackoffMs) >= 0
    ? Number(rawPluginConfig.voiceReplyRetryBackoffMs)
    : DEFAULT_VOICE_REPLY_RETRY_BACKOFF_MS;
  const promptToolTtsForText = typeof rawPluginConfig.promptToolTtsForText === "boolean"
    ? rawPluginConfig.promptToolTtsForText
    : DEFAULT_PROMPT_TOOL_TTS_FOR_TEXT;
  const enableBeforeAgentReply = typeof rawPluginConfig.enableBeforeAgentReply === "boolean"
    ? rawPluginConfig.enableBeforeAgentReply
    : DEFAULT_ENABLE_BEFORE_AGENT_REPLY;
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
    scriptPath: normalizeConfiguredScriptPath(
      readPluginStringField(rawPluginConfig, "scriptPath"),
      DEFAULT_SCRIPT_PATH,
      securityWarnings,
      "tts"
    ),
    defaults: {
      voice: readPluginStringField(rawPluginConfig, "defaultVoice") || DEFAULT_VOICE,
      rate: normalizeRateSetting(readPluginStringField(rawPluginConfig, "defaultRate"), DEFAULT_RATE),
      pitch: normalizePitchSetting(readPluginStringField(rawPluginConfig, "defaultPitch"), DEFAULT_PITCH)
    }
  };
  const stt = {
    scriptPath: normalizeConfiguredScriptPath(
      readPluginStringField(rawPluginConfig, "sttScriptPath"),
      DEFAULT_STT_SCRIPT_PATH,
      securityWarnings,
      "stt"
    ),
    language: readPluginStringField(rawPluginConfig, "sttLanguage") || DEFAULT_STT_LANGUAGE,
    model: readPluginStringField(rawPluginConfig, "sttModel") || DEFAULT_STT_MODEL
  };
  const voiceReply = {
    enabled: voiceReplyEnabled,
    mode: normalizedVoiceReplyMode,
    promptToolTtsForText,
    enableBeforeAgentReply,
    timing: {
      windowMs: voiceReplyWindowMs,
      cooldownMs: voiceReplyCooldownMs,
      debounceMs: voiceReplyDebounceMs,
      textSendingFallbackMs: voiceReplyTextSendingFallbackMs,
      noTextFallbackMs: voiceReplyNoTextFallbackMs,
      assistantSettleMs: voiceReplyAssistantSettleMs,
      retryCount: voiceReplyRetryCount,
      retryBackoffMs: voiceReplyRetryBackoffMs
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
    voiceReplyTextSendingFallbackMs,
    voiceReplyNoTextFallbackMs,
    voiceReplyAssistantSettleMs,
    voiceReplyRetryCount,
    voiceReplyRetryBackoffMs,
    promptToolTtsForText,
    enableBeforeAgentReply,
    voiceReplySummaryEnabled,
    voiceReplySummaryMaxSentences,
    voiceReplySummaryJoiner,
    voiceReplySummaryPrefix,
    voiceReplySummarySuffix,
    securityWarnings,
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
    voice: readSpeechField(requestProviderOverrides, "voice")
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
      || readPluginStringField(rawPluginConfig, "defaultVoice")
      || config.defaultVoice
      || DEFAULT_VOICE,
    rate: normalizeRateSetting(
      readSpeechField(requestProviderOverrides, "rate")
      || readSpeechField(requestProviderConfig, "rate")
      || requestLegacyEdgeConfig.rate
      || gatewayEdgeConfig.rate
      || readPluginStringField(rawPluginConfig, "defaultRate"),
      config.defaultRate
    ),
    pitch: normalizePitchSetting(
      readSpeechField(requestProviderOverrides, "pitch")
      || readSpeechField(requestProviderConfig, "pitch")
      || requestLegacyEdgeConfig.pitch
      || gatewayEdgeConfig.pitch
      || readPluginStringField(rawPluginConfig, "defaultPitch"),
      config.defaultPitch
    )
  };
}

module.exports = {
  normalizePitchSetting,
  normalizeRateSetting,
  readPluginStringField,
  resolvePluginConfig,
  resolveSpeechOptions,
  TRUSTED_SCRIPT_ROOTS
};
