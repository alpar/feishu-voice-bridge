"use strict";

const {
  DEFAULT_MAX_REPLY_CHARS,
  DEFAULT_MAX_CAPTURED_REPLY_CHARS,
  DEFAULT_VOICE_REPLY_SUMMARY_MAX_SENTENCES,
  DEFAULT_VOICE_REPLY_SUMMARY_JOINER,
  DEFAULT_VOICE_REPLY_SUMMARY_PREFIX,
  DEFAULT_VOICE_REPLY_SUMMARY_SUFFIX
} = require("./constants");
const { summarizeWithOpenClawTtsModel } = require("./openclaw-tts-summary");
const {
  normalizeSpeechText,
  normalizeSummarySourceText,
  splitSpeechSummarySentences
} = require("./speech-text");

function resolveVoiceReplySummaryConfig(config) {
  return {
    enabled: config?.voiceReplySummaryEnabled === true,
    maxReplyChars: Math.max(1, Number(config?.maxReplyChars) || DEFAULT_MAX_REPLY_CHARS),
    maxCapturedChars: Math.max(1, Number(config?.maxCapturedReplyChars) || DEFAULT_MAX_CAPTURED_REPLY_CHARS),
    maxSentences: Math.max(
      1,
      Math.min(10, Number(config?.voiceReplySummaryMaxSentences) || DEFAULT_VOICE_REPLY_SUMMARY_MAX_SENTENCES)
    ),
    joiner: typeof config?.voiceReplySummaryJoiner === "string" && config.voiceReplySummaryJoiner
      ? config.voiceReplySummaryJoiner
      : DEFAULT_VOICE_REPLY_SUMMARY_JOINER,
    prefix: typeof config?.voiceReplySummaryPrefix === "string"
      ? config.voiceReplySummaryPrefix
      : DEFAULT_VOICE_REPLY_SUMMARY_PREFIX,
    suffix: typeof config?.voiceReplySummarySuffix === "string"
      ? config.voiceReplySummarySuffix
      : DEFAULT_VOICE_REPLY_SUMMARY_SUFFIX
  };
}

function createVoiceReplySummaryContext(rawText, config) {
  const options = resolveVoiceReplySummaryConfig(config);
  const summarySourceText = normalizeSummarySourceText(rawText, options.maxCapturedChars);
  const speechText = normalizeSpeechText(rawText, options.maxCapturedChars);

  return {
    rawText,
    summarySourceText,
    speechText,
    sourceLength: speechText.length,
    options
  };
}

function buildRuleBasedSummaryText(context) {
  const { speechText, options } = context;
  const sentences = splitSpeechSummarySentences(speechText);
  const selectedSentences = sentences.length > 0
    ? sentences.slice(0, options.maxSentences)
    : [speechText.slice(0, options.maxReplyChars)];

  let summaryCore = selectedSentences.join(options.joiner).trim();
  if (!summaryCore) summaryCore = speechText.slice(0, options.maxReplyChars);

  const pieces = [];
  if (options.prefix) pieces.push(options.prefix);
  pieces.push(summaryCore);
  if (options.suffix) pieces.push(options.suffix);

  let summaryText = pieces.join("");
  if (summaryText.length > options.maxReplyChars) {
    summaryText = summaryText.slice(0, options.maxReplyChars);
  }

  return summaryText;
}

async function summarizeWithNativeModel(context, config, deps = {}) {
  if (!context.summarySourceText) return null;

  const summary = typeof deps.summarizeWithModel === "function"
    ? await deps.summarizeWithModel({
      text: context.summarySourceText,
      targetLength: context.options.maxReplyChars,
      cfg: config?.gatewayConfig,
      config
    })
    : await summarizeWithOpenClawTtsModel({
      text: context.summarySourceText,
      targetLength: context.options.maxReplyChars,
      cfg: config?.gatewayConfig,
      loadSpeechRuntime: deps.loadSpeechRuntime,
      summarizeTextDeps: deps.summarizeTextDeps
    });

  const normalizedSummary = normalizeSpeechText(
    typeof summary === "string" ? summary : summary?.text,
    context.options.maxReplyChars
  );

  if (!normalizedSummary) return null;

  return {
    text: normalizedSummary,
    summaryApplied: true,
    sourceLength: context.sourceLength,
    summaryStrategy: "openclaw-model"
  };
}

// 长文本优先使用 OpenClaw 官方摘要模型；失败时回退到规则摘要。
async function prepareVoiceReplySummary(rawText, config, deps = {}) {
  const context = createVoiceReplySummaryContext(rawText, config);
  if (!context.speechText) {
    return {
      text: "",
      summaryApplied: false,
      sourceLength: 0
    };
  }

  if (context.speechText.length <= context.options.maxReplyChars || !context.options.enabled) {
    return {
      text: context.speechText.slice(0, context.options.maxReplyChars),
      summaryApplied: false,
      sourceLength: context.sourceLength
    };
  }

  try {
    const nativeSummary = await summarizeWithNativeModel(context, config, deps);
    if (nativeSummary) return nativeSummary;
  } catch (err) {
    const detail = err && typeof err.message === "string" ? err.message : String(err);
    deps.logger?.warn?.(`feishu-voice model summary failed, fallback to rule summary: ${detail}`);
  }

  return {
    text: buildRuleBasedSummaryText(context),
    summaryApplied: true,
    sourceLength: context.sourceLength,
    summaryStrategy: "rule"
  };
}

module.exports = {
  buildRuleBasedSummaryText,
  createVoiceReplySummaryContext,
  prepareVoiceReplySummary,
  resolveVoiceReplySummaryConfig,
  summarizeWithNativeModel
};
