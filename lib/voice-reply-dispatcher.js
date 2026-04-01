"use strict";

const {
  normalizeAccountId,
  normalizeFeishuMessageId,
  normalizeFeishuTarget
} = require("./feishu");
const {
  buildTranscriptEchoMatcher,
  isProgressLikeVoiceReplyText,
  mergeVoiceReplyCandidate,
  normalizeSpeechText,
  prepareVoiceReplyText,
  shouldSkipVoiceReplyText
} = require("./text");
const { sendVoiceReply, extractToolGeneratedAudioArtifact } = require("./audio");
const {
  clearPendingRunAliases,
  rememberPendingRunAliases,
  resolveCanonicalRunKey
} = require("./voice-reply-store");

function createVoiceReplyDispatcher(params) {
  const { api, config, router, store, deps = {} } = params;
  const sendVoiceReplyImpl = typeof deps.sendVoiceReplyImpl === "function" ? deps.sendVoiceReplyImpl : sendVoiceReply;
  const prepareVoiceReplyTextImpl = typeof deps.prepareVoiceReplyTextImpl === "function"
    ? deps.prepareVoiceReplyTextImpl
    : prepareVoiceReplyText;
  const setTimerImpl = typeof deps.setTimer === "function" ? deps.setTimer : setTimeout;
  const clearTimerImpl = typeof deps.clearTimer === "function" ? deps.clearTimer : clearTimeout;
  const isTranscriptEchoText = buildTranscriptEchoMatcher(config);

  function sameOrNestedText(left, right) {
    const normalizedLeft = normalizeSpeechText(left, config.maxCapturedReplyChars);
    const normalizedRight = normalizeSpeechText(right, config.maxCapturedReplyChars);
    return !!normalizedLeft
      && !!normalizedRight
      && (normalizedLeft === normalizedRight
        || normalizedLeft.includes(normalizedRight)
        || normalizedRight.includes(normalizedLeft));
  }

  function attachToolAudioIfMatched(reply, toolReply) {
    if (!reply?.text) return reply;
    if (reply?.audio) return reply;
    if (!toolReply?.audio || !sameOrNestedText(reply.text, toolReply.text)) return reply;
    return {
      ...reply,
      audio: toolReply.audio
    };
  }

  function buildPendingRunAliases(ctx, route) {
    const aliases = [];
    const runId = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    const replyToMessageId = normalizeFeishuMessageId(route?.replyToMessageId);
    const target = normalizeFeishuTarget(route?.target);
    const accountId = typeof route?.accountId === "string" && route.accountId.trim() ? route.accountId.trim() : "default";

    if (runId) aliases.push(`run:${runId}`);
    if (replyToMessageId) aliases.push(`reply:${replyToMessageId}`);
    if (sessionKey) aliases.push(`session:${sessionKey}`);
    if (target) aliases.push(`target:${normalizeAccountId(accountId)}:${target}`);
    return aliases;
  }

  function resolvePendingRunKey(ctx, route) {
    const aliases = buildPendingRunAliases(ctx, route);
    for (const alias of aliases) {
      const existingRunKey = store.pendingRunAliasToKey.get(alias);
      if (!existingRunKey) continue;
      rememberPendingRunAliases(store, existingRunKey, aliases);
      return {
        runKey: existingRunKey,
        aliases
      };
    }

    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    const replyToMessageId = normalizeFeishuMessageId(route?.replyToMessageId);
    const runId = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";
    const fallbackKey = runId || (replyToMessageId ? `reply:${replyToMessageId}` : `${sessionKey || route?.target || "voice"}:fallback-run`);
    rememberPendingRunAliases(store, fallbackKey, aliases);
    return {
      runKey: fallbackKey,
      aliases
    };
  }

  function shouldAllowConversationVoiceReply(record) {
    if (config.voiceReplyMode !== "inbound") return true;
    const now = Date.now();
    const lastVoiceInboundAt = Number(record?.lastVoiceInboundAt || 0);
    const lastInboundAt = Number(record?.lastInboundAt || 0);
    const gatingTs = Math.max(lastVoiceInboundAt, lastInboundAt);
    if (!gatingTs || now - gatingTs > config.voiceReplyWindowMs) return false;
    return true;
  }

  function scheduleRunVoiceReplyFlush(runKey, reason, delayMs = 0) {
    const canonicalRunKey = resolveCanonicalRunKey(store, runKey);
    if (!canonicalRunKey) return;

    const pending = store.pendingRunVoiceByKey.get(canonicalRunKey);
    if (!pending) return;

    if (pending.timer) {
      clearTimerImpl(pending.timer);
      pending.timer = null;
    }

    const waitMs = Math.max(0, Number(delayMs) || 0);
    if (waitMs === 0) {
      void flushRunVoiceReply(canonicalRunKey, reason);
      return;
    }

    pending.timer = setTimerImpl(() => {
      const latestPending = store.pendingRunVoiceByKey.get(canonicalRunKey);
      if (latestPending) latestPending.timer = null;
      void flushRunVoiceReply(canonicalRunKey, reason);
    }, waitMs);
    store.pendingRunVoiceByKey.set(canonicalRunKey, pending);
  }

  async function flushRunVoiceReply(runKey, reason) {
    if (reason !== "agent_end") return;

    const canonicalRunKey = resolveCanonicalRunKey(store, runKey);
    if (!canonicalRunKey) return;
    const pending = store.pendingRunVoiceByKey.get(canonicalRunKey);
    if (!pending) return;
    if (!pending.agentEnded) return;

    if (pending.timer) {
      clearTimerImpl(pending.timer);
      pending.timer = null;
    }
    const preferredReply = attachToolAudioIfMatched(pending.preferredReply, pending.toolReply);
    const fallbackReply = attachToolAudioIfMatched(pending.fallbackReply, pending.toolReply);
    const bestReply = preferredReply?.text ? preferredReply : fallbackReply;
    const bestText = bestReply?.text || "";
    if (!bestText) return;
    if (shouldSkipVoiceReplyText(bestText)) return;

    store.pendingRunVoiceByKey.delete(canonicalRunKey);
    clearPendingRunAliases(store, canonicalRunKey, pending);

    const target = normalizeFeishuTarget(pending.target);
    const account = typeof pending.accountId === "string" && pending.accountId.trim() ? pending.accountId.trim() : "default";
    if (!target) return;

    const conversationKeys = router.mergeConversationKeys(
      pending.conversationKeys,
      [`${account}:${target}`]
    );
    const logKey = conversationKeys.join(",") || `${account}:${target}`;
    const record = router.readConversationRecord(conversationKeys);
    const pendingInboundTs = Math.max(Number(pending.lastVoiceInboundAt || 0), Number(pending.lastInboundAt || 0));
    const allowByInboundGate = shouldAllowConversationVoiceReply(record);
    const allowByPendingInbound = config.voiceReplyMode === "inbound"
      && pendingInboundTs > 0
      && Date.now() - pendingInboundTs <= config.voiceReplyWindowMs;

    if (!allowByInboundGate && !allowByPendingInbound) {
      api.logger?.info?.(`feishu-voice skip auto reply: inbound gate closed (run=${canonicalRunKey}, reason=${reason}, key=${logKey})`);
      return;
    }

    if (!allowByInboundGate && allowByPendingInbound) {
      api.logger?.info?.(`feishu-voice inbound gate fallback open (run=${canonicalRunKey}, reason=${reason}, mode=pending_inbound, key=${logKey}, replyTo=${pending.replyToMessageId})`);
    }

    const preparedSpeech = await prepareVoiceReplyTextImpl(bestText, config, {
      logger: api.logger,
      loadSpeechRuntime: config.runtime?.speechRuntime
        ? () => config.runtime.speechRuntime
        : undefined
    });
    const speechText = preparedSpeech?.text || "";
    if (!speechText) return;
    if (shouldSkipVoiceReplyText(speechText)) return;

    const now = Date.now();
    const lastVoiceReplyAt = Number(record.lastVoiceReplyAt || 0);
    if (lastVoiceReplyAt > 0 && now - lastVoiceReplyAt < config.voiceReplyCooldownMs) {
      api.logger?.info?.(`feishu-voice skip auto reply: cooldown active (run=${canonicalRunKey}, reason=${reason}, key=${logKey})`);
      return;
    }
    if (record.lastVoiceReplyText === speechText && lastVoiceReplyAt > 0 && now - lastVoiceReplyAt < config.voiceReplyWindowMs) {
      api.logger?.info?.(`feishu-voice skip auto reply: duplicate text in window (run=${canonicalRunKey}, reason=${reason}, key=${logKey})`);
      return;
    }

    try {
      if (preparedSpeech.summaryApplied) {
        api.logger?.info?.(`feishu-voice summarized voice reply (${preparedSpeech.sourceLength} chars -> ${speechText.length} chars, strategy=${preparedSpeech.summaryStrategy || "unknown"}, run=${canonicalRunKey})`);
      }
      const sent = await sendVoiceReplyImpl(config, api.logger, {
        chatId: target,
        text: speechText,
        audioArtifact: preparedSpeech.summaryApplied ? null : bestReply?.audio || null,
        replyToMessageId: pending.replyToMessageId,
        accountId: account
      });
      if (!sent) return;

      router.updateConversationRecords(conversationKeys, (nextRecord) => {
        nextRecord.lastVoiceReplyAt = now;
        nextRecord.lastVoiceReplyText = speechText;
      });
      api.logger?.info?.(`feishu-voice auto reply sent (mode=${config.voiceReplyMode}, target=${target}, reason=${reason})`);
    } catch (err) {
      const detail = err && typeof err.message === "string" ? err.message : String(err);
      api.logger?.warn?.(`feishu-voice auto reply failed: ${detail}`);
    }
  }

  function enqueueVoiceReply(reply, ctx, source) {
    if (config.voiceReplyEnabled !== true || config.voiceReplyMode === "off") return;
    const rawText = typeof reply?.text === "string" ? reply.text : "";
    if (source === "message_sent" && isTranscriptEchoText?.(rawText)) {
      api.logger?.info?.("feishu-voice skip message_sent capture: transcript echo");
      return;
    }
    const normalizedText = normalizeSpeechText(reply?.text, config.maxCapturedReplyChars);
    if (!normalizedText) return;

    const route = router.resolveSessionTarget(ctx);
    if (!route?.target) {
      api.logger?.info?.(`feishu-voice skip ${source} capture: unresolved session target`);
      return;
    }

    const { runKey, aliases } = resolvePendingRunKey(ctx, route);
    const existing = store.pendingRunVoiceByKey.get(runKey);
    if (existing?.timer) clearTimerImpl(existing.timer);

    const next = existing || {
      target: route.target,
      accountId: route.accountId
    };
    next.target = route.target;
    next.accountId = route.accountId;
    next.replyToMessageId = route.replyToMessageId || next.replyToMessageId;
    next.lastInboundAt = Math.max(Number(next.lastInboundAt || 0), Number(route.lastInboundAt || 0));
    next.lastVoiceInboundAt = Math.max(Number(next.lastVoiceInboundAt || 0), Number(route.lastVoiceInboundAt || 0));
    next.sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : next.sessionKey;
    next.aliases = Array.from(new Set([...(Array.isArray(next.aliases) ? next.aliases : []), ...aliases]));
    next.conversationKeys = router.mergeConversationKeys(next.conversationKeys, route.conversationKeys);

    const candidate = {
      text: normalizedText,
      audio: reply?.audio || null,
      source
    };

    if (source === "assistant_message") {
      next.hasAssistantMessage = true;
      next.preferredReply = attachToolAudioIfMatched(
        mergeVoiceReplyCandidate(next.preferredReply, candidate),
        next.toolReply
      );
    } else if (source === "tts_tool") {
      next.toolReply = candidate;
    } else if (isProgressLikeVoiceReplyText(normalizedText)) {
      next.fallbackReply = attachToolAudioIfMatched(
        mergeVoiceReplyCandidate(next.fallbackReply, candidate),
        next.toolReply
      );
    } else {
      next.fallbackReply = attachToolAudioIfMatched(
        mergeVoiceReplyCandidate(next.fallbackReply, candidate),
        next.toolReply
      );
    }

    if (next.timer) {
      clearTimerImpl(next.timer);
      next.timer = null;
    }
    store.pendingRunVoiceByKey.set(runKey, next);
    rememberPendingRunAliases(store, runKey, next.aliases);
    api.logger?.info?.(`feishu-voice captured ${source} text (run=${runKey}, target=${route.target}, preferred=${next.preferredReply?.text ? "yes" : "no"}, audio=${candidate.audio ? "yes" : "no"})`);

    if (next.agentEnded) {
      scheduleRunVoiceReplyFlush(runKey, "agent_end", config.voiceReplyDebounceMs);
    }
  }

  function handleAfterToolCall(event, ctx) {
    if (event?.toolName !== "tts" || event?.error) return;

    const artifact = extractToolGeneratedAudioArtifact(event?.result, api.logger);
    if (!artifact) return;

    const toolParams = event?.params && typeof event.params === "object" ? event.params : {};
    const text = typeof toolParams.ttsText === "string" && toolParams.ttsText.trim()
      ? toolParams.ttsText
      : typeof toolParams.text === "string"
        ? toolParams.text
        : "";
    if (!text.trim()) return;

    enqueueVoiceReply({
      text,
      audio: artifact
    }, {
      accountId: typeof ctx?.accountId === "string" ? ctx.accountId : undefined,
      runId: typeof ctx?.runId === "string" ? ctx.runId : undefined,
      sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined
    }, "tts_tool");
  }

  function handleAgentEnd(event, ctx) {
    const runKey = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    const canonicalRunKey = runKey ? resolveCanonicalRunKey(store, runKey) : "";
    const hasCanonicalPending = canonicalRunKey ? store.pendingRunVoiceByKey.has(canonicalRunKey) : false;
    const fallbackSessionRunKey = sessionKey ? resolveCanonicalRunKey(store, `session:${sessionKey}`) : "";
    const hasSessionPending = fallbackSessionRunKey ? store.pendingRunVoiceByKey.has(fallbackSessionRunKey) : false;
    const effectiveRunKey = hasCanonicalPending
      ? canonicalRunKey
      : hasSessionPending
        ? fallbackSessionRunKey
        : canonicalRunKey || fallbackSessionRunKey;

    if (!effectiveRunKey) {
      api.logger?.info?.("feishu-voice skip agent_end flush: missing run/session target");
      return;
    }

    const pending = store.pendingRunVoiceByKey.get(effectiveRunKey);
    if (pending && event?.success === false) {
      if (pending.timer) clearTimerImpl(pending.timer);
      clearPendingRunAliases(store, effectiveRunKey, pending);
      store.pendingRunVoiceByKey.delete(effectiveRunKey);
      api.logger?.info?.(`feishu-voice cleared pending reply after unsuccessful agent_end (run=${effectiveRunKey})`);
      return;
    }

    if (pending) {
      pending.agentEnded = true;
      store.pendingRunVoiceByKey.set(effectiveRunKey, pending);
    }
    scheduleRunVoiceReplyFlush(effectiveRunKey, "agent_end", config.voiceReplyDebounceMs);
  }

  function handleSessionEnd(ctx) {
    const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
    if (!sessionKey) return;

    for (const [runKey, pending] of store.pendingRunVoiceByKey.entries()) {
      if (pending?.sessionKey === sessionKey || Array.isArray(pending?.aliases) && pending.aliases.includes(`session:${sessionKey}`)) {
        if (pending?.timer) clearTimerImpl(pending.timer);
        clearPendingRunAliases(store, runKey, pending);
        store.pendingRunVoiceByKey.delete(runKey);
      }
    }
    router.clearSession(sessionKey);
  }

  return {
    enqueueVoiceReply,
    flushRunVoiceReply,
    handleAfterToolCall,
    handleAgentEnd,
    handleSessionEnd
  };
}

module.exports = {
  createVoiceReplyDispatcher
};
