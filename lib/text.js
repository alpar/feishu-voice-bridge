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

const AUTHORITATIVE_SOURCES = new Set(["assistant_message", "before_agent_reply", "message_sent"]);

// 长文本先走模型摘要，失败再回退到规则摘要。
async function prepareVoiceReplyText(rawText, config, deps = {}) {
  return prepareVoiceReplySummary(rawText, config, deps);
}

// 最终文本优先；只有文案接近时才复用工具音频。
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

  if (existingSource && existingSource === nextSource && AUTHORITATIVE_SOURCES.has(nextSource)) {
    return {
      text: nextText,
      audio: keepAudioForAuthoritativeText(nextReply, existingReply),
      source: nextSource
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
  const skipMarkers = [
    "no_reply",
    "agent was aborted."
  ];
  return skipMarkers.some((marker) => normalized.includes(marker));
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
    "开始为您",
    "approval required",
    "requires approval",
    "awaiting approval",
    "needs approval",
    "permission required",
    "requires permission",
    "awaiting permission",
    "请先审批",
    "等待审批",
    "需要审批",
    "需要你确认",
    "等待你确认",
    "请先授权",
    "等待授权",
    "需要授权",
    "new session started",
    "session started",
    "initializing new session",
    "starting new session"
  ];

  if (progressPatterns.some((pattern) => normalized.includes(pattern.toLowerCase()))) {
    return true;
  }

  return normalized.includes("model:")
    && (normalized.includes("new session") || normalized.includes("session started"));
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
