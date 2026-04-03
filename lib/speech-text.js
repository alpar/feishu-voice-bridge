"use strict";

const { SPEECH_EMOJI_REGEX } = require("./constants");

function normalizeText(input) {
  if (typeof input !== "string") return "";
  return input.replace(/\s+/gu, " ").trim();
}

function stripStructuredSpeechArtifacts(input) {
  let text = typeof input === "string" ? input : "";
  if (!text.trim()) return "";

  const dropEntireBlockPatterns = [
    /<([a-zA-Z][\w:-]*)\b[^>]*\brole\s*=\s*["']?user["']?[^>]*>[\s\S]*?<\/\1>/giu,
    /<([a-zA-Z][\w:-]*)\b[^>]*\b(?:source|kind|type)\s*=\s*["']?(?:user|input|transcript|stt)["']?[^>]*>[\s\S]*?<\/\1>/giu,
    /<(?:transcript|audio_transcript|speech_transcript|user_input|user_message|input|metadata|meta)\b[^>]*>[\s\S]*?<\/(?:transcript|audio_transcript|speech_transcript|user_input|user_message|input|metadata|meta)>/giu
  ];

  for (const pattern of dropEntireBlockPatterns) {
    text = text.replace(pattern, " ");
  }

  return text
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gu, " ")
    .replace(/<\?xml[\s\S]*?\?>/giu, " ")
    .replace(/<\/?[a-zA-Z][\w:-]*(?:\s+[^<>]*?)?>/gu, " ")
    .replace(/^(?:语音转写|转写内容|transcript|speech[- ]?to[- ]?text|stt)\s*[:：].*$/gimu, " ")
    .replace(/\s+/gu, " ")
    .trim();
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
    .replace(/^\s*>\s+/gmu, "")
    .replace(/\|/gu, " ")
    .replace(SPEECH_EMOJI_REGEX, " ")
    .replace(/NO_REPLY/giu, "");

  text = stripStructuredSpeechArtifacts(text)
    .replace(/\s+/gu, " ")
    .trim();

  if (!text) return "";
  return text.slice(0, Math.max(1, maxChars));
}

// 给摘要模型看的原文尽量保留语义结构，只去掉明显噪音。
function normalizeSummarySourceText(input, maxChars) {
  let text = typeof input === "string" ? input : "";
  if (!text.trim()) return "";

  text = text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(SPEECH_EMOJI_REGEX, " ")
    .replace(/NO_REPLY/giu, "");

  text = stripStructuredSpeechArtifacts(text)
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

module.exports = {
  buildTranscriptEchoMatcher,
  normalizeSpeechText,
  normalizeSummarySourceText,
  normalizeText,
  resolveTranscriptEchoFormat,
  stripStructuredSpeechArtifacts,
  splitSpeechSummarySentences
};
