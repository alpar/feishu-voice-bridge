"use strict";

const {
  DEFAULT_MAX_REPLY_CHARS,
  DEFAULT_MAX_CAPTURED_REPLY_CHARS,
  DEFAULT_VOICE_REPLY_SUMMARY_MAX_SENTENCES,
  DEFAULT_VOICE_REPLY_SUMMARY_JOINER,
  DEFAULT_VOICE_REPLY_SUMMARY_PREFIX,
  DEFAULT_VOICE_REPLY_SUMMARY_SUFFIX,
  SPEECH_EMOJI_REGEX
} = require("./constants");

const AUTHORITATIVE_SOURCES = new Set(["assistant_message", "message_sent"]);

function normalizeText(input) {
  if (typeof input !== "string") return "";
  return input.replace(/\s+/gu, " ").trim();
}

// 语音播放对 Markdown、代码块和 emoji 都不友好，这里统一做口语化清洗。
function normalizeSpeechText(input, maxChars) {
  let text = typeof input === "string" ? input : "";
  if (!text.trim()) return "";

  text = text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/^\s*\d+\.\s+/gmu, "")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/\*([^*]+)\*/gu, "$1")
    .replace(SPEECH_EMOJI_REGEX, " ")
    .replace(/NO_REPLY/giu, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (!text) return "";
  return text.slice(0, Math.max(1, maxChars));
}

function splitSpeechSummarySentences(text) {
  if (!text) return [];
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const sentences = normalized
    .split(/(?<=[。！？!?])/u)
    .map((part) => normalizeText(part))
    .filter(Boolean);

  if (sentences.length > 0) return sentences;

  return normalized
    .split(/[,，；;:\n]/u)
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

// 长文本不直接硬截断，而是裁成更适合播放的摘要语句。
function prepareVoiceReplyText(rawText, config) {
  const maxCaptured = Math.max(1, Number(config?.maxCapturedReplyChars) || DEFAULT_MAX_CAPTURED_REPLY_CHARS);
  const sanitized = normalizeSpeechText(rawText, maxCaptured);
  if (!sanitized) {
    return {
      text: "",
      summaryApplied: false,
      sourceLength: 0
    };
  }

  const maxReplyChars = Math.max(1, Number(config?.maxReplyChars) || DEFAULT_MAX_REPLY_CHARS);
  if (sanitized.length <= maxReplyChars || config?.voiceReplySummaryEnabled !== true) {
    return {
      text: sanitized.slice(0, maxReplyChars),
      summaryApplied: false,
      sourceLength: sanitized.length
    };
  }

  const maxSentences = Math.max(
    1,
    Math.min(10, Number(config?.voiceReplySummaryMaxSentences) || DEFAULT_VOICE_REPLY_SUMMARY_MAX_SENTENCES)
  );
  const joiner = typeof config?.voiceReplySummaryJoiner === "string" && config.voiceReplySummaryJoiner
    ? config.voiceReplySummaryJoiner
    : DEFAULT_VOICE_REPLY_SUMMARY_JOINER;
  const prefix = typeof config?.voiceReplySummaryPrefix === "string"
    ? config.voiceReplySummaryPrefix
    : DEFAULT_VOICE_REPLY_SUMMARY_PREFIX;
  const suffix = typeof config?.voiceReplySummarySuffix === "string"
    ? config.voiceReplySummarySuffix
    : DEFAULT_VOICE_REPLY_SUMMARY_SUFFIX;
  const sentences = splitSpeechSummarySentences(sanitized);
  const selectedSentences = sentences.length > 0
    ? sentences.slice(0, maxSentences)
    : [sanitized.slice(0, maxReplyChars)];

  let summaryCore = selectedSentences.join(joiner).trim();
  if (!summaryCore) summaryCore = sanitized.slice(0, maxReplyChars);

  const pieces = [];
  if (prefix) pieces.push(prefix);
  pieces.push(summaryCore);
  if (suffix) pieces.push(suffix);

  let summaryText = pieces.join("");
  if (summaryText.length > maxReplyChars) {
    summaryText = summaryText.slice(0, maxReplyChars);
  }

  return {
    text: summaryText,
    summaryApplied: true,
    sourceLength: sanitized.length
  };
}

// assistant 最终文本优先级最高；只有文本相近时才复用工具生成的音频。
function mergeVoiceReplyCandidate(existingReply, nextReply) {
  const existingText = normalizeText(existingReply?.text);
  const nextText = normalizeText(nextReply?.text);
  const existingSource = typeof existingReply?.source === "string" ? existingReply.source : "";
  const nextSource = typeof nextReply?.source === "string" ? nextReply.source : "";
  const sameOrNestedText = (left, right) => !!left && !!right && (left === right || left.includes(right) || right.includes(left));
  const keepAudioForAuthoritativeText = (authoritativeReply, counterpartReply) => {
    if (authoritativeReply?.audio) return authoritativeReply.audio;
    if (sameOrNestedText(authoritativeReply?.text, counterpartReply?.text)) {
      return counterpartReply?.audio || null;
    }
    return null;
  };

  if (!existingText) {
    return nextText
      ? { text: nextText, audio: nextReply?.audio || null, source: nextSource }
      : null;
  }
  if (!nextText) return existingReply || null;

  if (existingText === nextText) {
    return {
      text: existingText,
      audio: nextReply?.audio || existingReply?.audio || null,
      source: nextSource || existingSource
    };
  }

  if (AUTHORITATIVE_SOURCES.has(nextSource) || AUTHORITATIVE_SOURCES.has(existingSource)) {
    const authoritativeReply = AUTHORITATIVE_SOURCES.has(nextSource) ? nextReply : existingReply;
    const counterpartReply = authoritativeReply === nextReply ? existingReply : nextReply;
    return {
      text: normalizeText(authoritativeReply?.text),
      audio: keepAudioForAuthoritativeText(authoritativeReply, counterpartReply),
      source: authoritativeReply?.source || nextSource || existingSource
    };
  }

  if (nextText.includes(existingText)) {
    return {
      text: nextText,
      audio: nextReply?.audio || null,
      source: nextSource || existingSource
    };
  }

  if (existingText.includes(nextText)) {
    return {
      text: existingText,
      audio: existingReply?.audio || nextReply?.audio || null,
      source: existingSource || nextSource
    };
  }

  return {
    text: `${existingText}\n${nextText}`,
    audio: null,
    source: nextSource || existingSource
  };
}

function shouldSkipVoiceReplyText(text) {
  if (!text) return true;
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return true;
  return normalized.includes("no_reply");
}

function resolveTranscriptEchoFormat(config) {
  const audioConfig = config?.gatewayConfig?.tools?.media?.audio;
  if (!audioConfig || audioConfig.echoTranscript !== true) return "";
  return typeof audioConfig.echoFormat === "string" && audioConfig.echoFormat.trim()
    ? audioConfig.echoFormat.trim()
    : "{transcript}";
}

function buildTranscriptEchoMatcher(config) {
  const echoFormat = resolveTranscriptEchoFormat(config);
  if (!echoFormat || !echoFormat.includes("{transcript}")) return null;

  const [prefixRaw, suffixRaw] = echoFormat.split("{transcript}");
  const prefix = normalizeText(prefixRaw);
  const suffix = normalizeText(suffixRaw);

  return (text) => {
    const normalizedText = normalizeText(text);
    if (!normalizedText) return false;
    if (prefix && !normalizedText.startsWith(prefix)) return false;
    if (suffix && !normalizedText.endsWith(suffix)) return false;

    const coreStart = prefix ? prefix.length : 0;
    const coreEnd = suffix ? normalizedText.length - suffix.length : normalizedText.length;
    const transcriptCore = normalizeText(normalizedText.slice(coreStart, coreEnd));
    return !!transcriptCore;
  };
}

function isProgressLikeVoiceReplyText(text) {
  if (!text) return false;
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return false;

  const progressPatterns = [
    "好的，马上",
    "马上为您",
    "请稍等",
    "正在",
    "我会继续",
    "我先",
    "收到",
    "测试收到",
    "立即为您",
    "马上检查",
    "开始为您"
  ];

  return progressPatterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

function extractMessageSentText(event) {
  const candidates = [
    event?.text,
    event?.content,
    event?.body,
    event?.message,
    event?.rawText,
    event?.payload?.text,
    event?.payload?.content,
    event?.details?.text,
    event?.details?.content
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (!candidate || typeof candidate !== "object") continue;

    const nestedCandidates = [
      candidate.text,
      candidate.content,
      candidate.body,
      candidate.message,
      candidate.rawText
    ];
    for (const nested of nestedCandidates) {
      if (typeof nested === "string" && nested.trim()) return nested;
    }
  }

  return "";
}

function extractAssistantTextFromAgentMessage(message) {
  if (!message || message.role !== "assistant") return "";
  const content = Array.isArray(message.content) ? message.content : [];
  const textParts = [];

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type !== "text") continue;
    if (typeof part.text !== "string" || !part.text.trim()) continue;
    textParts.push(part.text);
  }

  return textParts.join("\n").trim();
}

module.exports = {
  buildTranscriptEchoMatcher,
  extractAssistantTextFromAgentMessage,
  extractMessageSentText,
  isProgressLikeVoiceReplyText,
  mergeVoiceReplyCandidate,
  normalizeSpeechText,
  normalizeText,
  prepareVoiceReplyText,
  resolveTranscriptEchoFormat,
  shouldSkipVoiceReplyText,
  splitSpeechSummarySentences
};
