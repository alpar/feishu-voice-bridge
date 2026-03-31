"use strict";

const {
  buildTranscriptEchoMatcher,
  normalizeSpeechText,
  normalizeSummarySourceText,
  normalizeText,
  resolveTranscriptEchoFormat,
  splitSpeechSummarySentences
} = require("./speech-text");
const { prepareVoiceReplySummary } = require("./voice-reply-summary");

const AUTHORITATIVE_SOURCES = new Set(["assistant_message", "message_sent"]);

// 长文本优先使用 OpenClaw 官方 TTS 摘要模型；失败时回退到规则摘要。
async function prepareVoiceReplyText(rawText, config, deps = {}) {
  return prepareVoiceReplySummary(rawText, config, deps);
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
  normalizeSummarySourceText,
  normalizeText,
  prepareVoiceReplyText,
  resolveTranscriptEchoFormat,
  shouldSkipVoiceReplyText,
  splitSpeechSummarySentences
};
