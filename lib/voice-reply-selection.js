"use strict";

const {
  isProgressLikeVoiceReplyText,
  normalizeSpeechText
} = require("./text");

function sameOrNestedText(left, right, maxCapturedReplyChars) {
  const normalizedLeft = normalizeSpeechText(left, maxCapturedReplyChars);
  const normalizedRight = normalizeSpeechText(right, maxCapturedReplyChars);
  return !!normalizedLeft
    && !!normalizedRight
    && (normalizedLeft === normalizedRight
      || normalizedLeft.includes(normalizedRight)
      || normalizedRight.includes(normalizedLeft));
}

function buildReplyTextPreview(text, options = {}) {
  const previewLimit = Math.max(8, Math.min(160, Number(options.maxChars) || 48));
  const normalized = normalizeSpeechText(text, previewLimit * 3);
  if (!normalized) return "";
  const singleLine = normalized.replace(/\s+/gu, " ").trim();
  if (!singleLine) return "";
  return singleLine.length > previewLimit
    ? `${singleLine.slice(0, previewLimit)}...`
    : singleLine;
}

function describeReplyCandidate(reply, options = {}) {
  if (!reply?.text) return `${options.label || "reply"}=none`;
  const normalized = normalizeSpeechText(reply.text, options.maxCapturedReplyChars);
  return `${options.label || "reply"}=${reply.source || "unknown"}(chars=${normalized.length},audio=${reply.audio ? "yes" : "no"},preview=${buildReplyTextPreview(normalized) || "empty"})`;
}

function describePendingState(pending, options = {}) {
  if (!pending) return "pending=none";
  return [
    describeReplyCandidate(pending.preferredReply, {
      label: "preferred",
      maxCapturedReplyChars: options.maxCapturedReplyChars
    }),
    describeReplyCandidate(pending.fallbackReply, {
      label: "fallback",
      maxCapturedReplyChars: options.maxCapturedReplyChars
    }),
    describeReplyCandidate(pending.toolReply, {
      label: "tool",
      maxCapturedReplyChars: options.maxCapturedReplyChars
    }),
    `textSending=${pending.textSending ? "yes" : "no"}`,
    `textSent=${pending.textSent ? "yes" : "no"}`,
    `final=${pending.hasFinalReply ? "yes" : "no"}`,
    `assistant=${pending.hasAssistantMessage ? "yes" : "no"}`
  ].join(", ");
}

function attachToolAudioIfMatched(reply, toolReply, maxCapturedReplyChars) {
  if (!reply?.text) return reply;
  if (reply?.audio) return reply;
  if (!toolReply?.audio || !sameOrNestedText(reply.text, toolReply.text, maxCapturedReplyChars)) {
    return reply;
  }
  return {
    ...reply,
    audio: toolReply.audio
  };
}

function chooseBestReply(preferredReply, fallbackReply, toolReply, options = {}) {
  const maxCapturedReplyChars = options.maxCapturedReplyChars;
  const preferred = attachToolAudioIfMatched(preferredReply, toolReply, maxCapturedReplyChars);
  const fallback = attachToolAudioIfMatched(fallbackReply, toolReply, maxCapturedReplyChars);
  const tool = toolReply?.text
    ? attachToolAudioIfMatched(toolReply, toolReply, maxCapturedReplyChars)
    : null;

  if (fallback?.text && preferred?.text) {
    const fallbackLooksLikeProgress = isProgressLikeVoiceReplyText(fallback.text);
    const preferredLooksLikeProgress = isProgressLikeVoiceReplyText(preferred.text);
    if (
      fallbackLooksLikeProgress
      && !preferredLooksLikeProgress
      && !sameOrNestedText(fallback.text, preferred.text, maxCapturedReplyChars)
    ) {
      return {
        reply: preferred,
        reason: "preferred_overrode_progress_fallback",
        preferred,
        fallback,
        tool
      };
    }
  }

  if (fallback?.text) {
    return {
      reply: fallback,
      reason: preferred?.text ? "fallback_preferred_when_available" : "fallback_only",
      preferred,
      fallback,
      tool
    };
  }
  if (tool?.text) {
    return {
      reply: tool,
      reason: preferred?.text ? "tool_preferred_without_fallback" : "tool_only",
      preferred,
      fallback,
      tool
    };
  }
  return {
    reply: preferred,
    reason: preferred?.text ? "preferred_only" : "empty",
    preferred,
    fallback,
    tool
  };
}

function resolveAudioArtifactForSend(reply) {
  const artifact = reply?.audio || null;
  if (!artifact) return null;
  // tts 工具产出的原始音频在飞书里出现过“无时长”回归；
  // 发送阶段统一回退到本地稳定合成，只保留文本，不直接复用该音频。
  if (artifact?.source === "tts-tool") {
    return null;
  }
  return artifact;
}

module.exports = {
  attachToolAudioIfMatched,
  buildReplyTextPreview,
  chooseBestReply,
  describePendingState,
  describeReplyCandidate,
  resolveAudioArtifactForSend,
  sameOrNestedText
};
