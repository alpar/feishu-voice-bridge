"use strict";

const { mergeVoiceReplyCandidate } = require("./text");

function createPendingVoiceTurn(route) {
  return {
    target: route?.target,
    accountId: route?.accountId
  };
}

function applySessionSignalsToPending(pending, sessionSignals = {}) {
  const next = pending;
  if (!next || !sessionSignals || typeof sessionSignals !== "object") return next;

  if (!next.agentEnded && sessionSignals.agentEndedRecently) {
    next.agentEnded = true;
  }
  if (!next.textSent && Number(sessionSignals.lastTextSentAt || 0) > 0) {
    next.textSent = true;
  }
  const lastTextSendingAt = Number(sessionSignals.lastTextSendingAt || 0);
  if (!next.textSending && lastTextSendingAt > 0) {
    next.textSending = true;
    next.lastTextSendingAt = Math.max(Number(next.lastTextSendingAt || 0), lastTextSendingAt);
  }
  if (!next.transcriptEchoSkipped && sessionSignals.transcriptEchoSkipped) {
    next.transcriptEchoSkipped = true;
  }
  return next;
}

function mergePendingReplyCandidate(pending, source, candidate, deps = {}) {
  const next = pending;
  const attachToolAudioIfMatched = typeof deps.attachToolAudioIfMatched === "function"
    ? deps.attachToolAudioIfMatched
    : (reply) => reply;

  const mergeFallbackReply = () => {
    next.fallbackReply = attachToolAudioIfMatched(
      mergeVoiceReplyCandidate(next.fallbackReply, candidate),
      next.toolReply
    );
  };

  if (source === "assistant_message" || source === "before_agent_reply") {
    next.hasAssistantMessage = true;
    next.lastAssistantMessageAt = Date.now();
    if (source === "before_agent_reply") {
      next.hasFinalReply = true;
    }
    next.preferredReply = attachToolAudioIfMatched(
      mergeVoiceReplyCandidate(next.preferredReply, candidate),
      next.toolReply
    );
    return next;
  }

  if (source === "tts_tool") {
    next.toolReply = candidate;
    return next;
  }

  if (source === "message_sent") {
    next.textSent = true;
    mergeFallbackReply();
    return next;
  }

  mergeFallbackReply();
  return next;
}

function resolvePendingFlushPlan(pending, config) {
  if (!pending?.agentEnded) return null;
  if (pending.hasFinalReply) {
    return {
      reason: "final_reply",
      delayMs: Number(config.voiceReplyDebounceMs || 0)
    };
  }
  if (pending.textSent) {
    return {
      reason: "agent_end",
      delayMs: Number(config.voiceReplyDebounceMs || 0)
    };
  }
  if (pending.textSending) {
    return {
      reason: "message_sending_fallback",
      delayMs: Number(config.voiceReplyTextSendingFallbackMs || 0)
    };
  }

  const hasInboundForNoTextFallback = pending.lastVoiceInboundAt > 0
    || (config.voiceReplyMode === "always" && pending.lastInboundAt > 0);
  const allowNoTextFallback = hasInboundForNoTextFallback
    && pending.hasAssistantMessage
    && (
      pending.transcriptEchoSkipped
      || config.voiceReplyMode === "always"
    );
  if (!allowNoTextFallback) return null;

  const assistantSettleMs = Math.max(0, Number(config.voiceReplyAssistantSettleMs || 0));
  const fallbackDelayMs = pending.preferredReply?.text
    ? Math.max(Number(config.voiceReplyNoTextFallbackMs || 0), assistantSettleMs)
    : Number(config.voiceReplyNoTextFallbackMs || 0);
  return {
    reason: "no_text_fallback",
    delayMs: fallbackDelayMs
  };
}

function evaluatePendingFlushReadiness(pending, reason, config, now = Date.now()) {
  if (!pending?.agentEnded) {
    return { allowed: false };
  }
  if (reason === "final_reply") {
    return { allowed: !!pending.hasFinalReply };
  }
  if (reason === "agent_end") {
    return { allowed: !!pending.textSent };
  }
  if (reason === "message_sending_fallback") {
    const lastTextSendingAt = Number(pending.lastTextSendingAt || 0);
    return {
      allowed: !!pending.textSending
        && lastTextSendingAt > 0
        && now - lastTextSendingAt >= Math.max(0, Number(config.voiceReplyTextSendingFallbackMs || 0)),
      fallbackMode: "message_sending"
    };
  }
  if (reason === "no_text_fallback") {
    const allowed = (
      pending.lastVoiceInboundAt > 0
      || (config.voiceReplyMode === "always" && pending.lastInboundAt > 0)
    )
      && pending.hasAssistantMessage
      && (pending.transcriptEchoSkipped || config.voiceReplyMode === "always")
      && !pending.textSending;
    return {
      allowed,
      fallbackMode: "assistant"
    };
  }
  return { allowed: false };
}

module.exports = {
  applySessionSignalsToPending,
  createPendingVoiceTurn,
  evaluatePendingFlushReadiness,
  mergePendingReplyCandidate,
  resolvePendingFlushPlan
};
