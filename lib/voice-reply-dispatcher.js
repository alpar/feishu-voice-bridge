"use strict";

const {
  normalizeAccountId,
  normalizeFeishuMessageId,
  normalizeFeishuTarget
} = require("./feishu");
const {
  buildTranscriptEchoMatcher,
  extractMessageSentText,
  isProgressLikeVoiceReplyText,
  mergeVoiceReplyCandidate,
  normalizeSpeechText,
  prepareVoiceReplyText,
  shouldSkipVoiceReplyText
} = require("./text");
const { sendVoiceReply, extractToolGeneratedAudioArtifact } = require("./audio");
const {
  clearPendingRunAliases,
  pruneExpiryMap,
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
  const dispatchAsyncImpl = typeof deps.dispatchAsync === "function"
    ? deps.dispatchAsync
    : (fn) => Promise.resolve().then(fn).catch((err) => {
      const detail = err && typeof err.message === "string" ? err.message : String(err);
      api.logger?.warn?.(`feishu-voice async dispatch failed: ${detail}`);
    });
  const isTranscriptEchoText = buildTranscriptEchoMatcher(config);
  const voiceSendQueue = [];
  let voiceSendQueueRunning = false;
  let nextBackgroundJobId = 1;

  function buildVoiceTurnKey(accountId, target, inboundMessageId, inboundAt) {
    const normalizedTarget = normalizeFeishuTarget(target);
    if (!normalizedTarget) return "";
    const normalizedAccount = normalizeAccountId(accountId);
    const normalizedMessageId = normalizeFeishuMessageId(inboundMessageId);
    if (normalizedMessageId) {
      return `${normalizedAccount}:${normalizedTarget}:msg:${normalizedMessageId}`;
    }
    const normalizedInboundAt = Number(inboundAt || 0);
    if (normalizedInboundAt > 0) {
      return `${normalizedAccount}:${normalizedTarget}:ts:${normalizedInboundAt}`;
    }
    return "";
  }

  function rememberRecentAgentEnd(ctx) {
    const now = Date.now();
    const expiresAt = now + Math.max(config.voiceReplyWindowMs, 60_000);
    const runId = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    pruneExpiryMap(store.agentEndExpiryByRunKey, now);
    pruneExpiryMap(store.agentEndExpiryBySessionKey, now);
    if (runId) {
      store.agentEndExpiryByRunKey.set(runId, expiresAt);
    }
    if (sessionKey) {
      store.agentEndExpiryBySessionKey.set(sessionKey, expiresAt);
    }
  }

  function clearRecentAgentEnd(ctx) {
    const runId = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    if (runId) {
      store.agentEndExpiryByRunKey.delete(runId);
    }
    if (sessionKey) {
      store.agentEndExpiryBySessionKey.delete(sessionKey);
    }
  }

  function wasAgentEndedRecently(ctx) {
    const now = Date.now();
    pruneExpiryMap(store.agentEndExpiryByRunKey, now);
    pruneExpiryMap(store.agentEndExpiryBySessionKey, now);
    const runId = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";
    if (runId && Number(store.agentEndExpiryByRunKey.get(runId) || 0) > now) {
      return true;
    }
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    return !!(sessionKey && Number(store.agentEndExpiryBySessionKey.get(sessionKey) || 0) > now);
  }

  function hasCompletedVoiceTurn(turnKey) {
    if (!turnKey) return false;
    pruneExpiryMap(store.completedVoiceTurnExpiryByKey, Date.now());
    const expiresAt = Number(store.completedVoiceTurnExpiryByKey.get(turnKey) || 0);
    return expiresAt > Date.now();
  }

  function markCompletedVoiceTurn(turnKey) {
    if (!turnKey) return;
    pruneExpiryMap(store.completedVoiceTurnExpiryByKey, Date.now());
    store.completedVoiceTurnExpiryByKey.set(
      turnKey,
      Date.now() + Math.max(config.voiceReplyWindowMs, 60_000)
    );
  }

  function enqueueBackgroundVoiceSend(job) {
    const queuedJob = {
      enqueuedAt: Date.now(),
      id: nextBackgroundJobId++,
      ...job
    };
    voiceSendQueue.push(queuedJob);
    api.logger?.info?.(`feishu-voice queue enqueued (job=${queuedJob.id}, run=${queuedJob.runKey}, attempt=${queuedJob.attempt}/${queuedJob.maxAttempts}, depth=${voiceSendQueue.length})`);
    if (voiceSendQueueRunning) return;

    voiceSendQueueRunning = true;
    dispatchAsyncImpl(async () => {
      while (voiceSendQueue.length > 0) {
        const nextJob = voiceSendQueue.shift();
        if (!nextJob) continue;

        try {
          const waitMs = Math.max(0, Date.now() - Number(nextJob.enqueuedAt || 0));
          api.logger?.info?.(`feishu-voice queue started (job=${nextJob.id}, run=${nextJob.runKey}, attempt=${nextJob.attempt}/${nextJob.maxAttempts}, depth=${voiceSendQueue.length}, queuedMs=${waitMs})`);
          await nextJob.execute();
          api.logger?.info?.(`feishu-voice queue finished (job=${nextJob.id}, run=${nextJob.runKey}, attempt=${nextJob.attempt}/${nextJob.maxAttempts}, depth=${voiceSendQueue.length})`);
        } catch (err) {
          const detail = err && typeof err.message === "string" ? err.message : String(err);
          api.logger?.warn?.(`feishu-voice background send failed (job=${nextJob.id}, run=${nextJob.runKey}, attempt=${nextJob.attempt}/${nextJob.maxAttempts}): ${detail}`);
        }
      }
      voiceSendQueueRunning = false;
    });
  }

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

  function chooseBestReply(preferredReply, fallbackReply, toolReply) {
    const preferred = attachToolAudioIfMatched(preferredReply, toolReply);
    const fallback = attachToolAudioIfMatched(fallbackReply, toolReply);
    const tool = toolReply?.text ? attachToolAudioIfMatched(toolReply, toolReply) : null;

    if (fallback?.text && preferred?.text) {
      const fallbackLooksLikeProgress = isProgressLikeVoiceReplyText(fallback.text);
      const preferredLooksLikeProgress = isProgressLikeVoiceReplyText(preferred.text);
      if (
        fallbackLooksLikeProgress
        && !preferredLooksLikeProgress
        && !sameOrNestedText(fallback.text, preferred.text)
      ) {
        return preferred;
      }
    }

    if (fallback?.text) return fallback;
    if (tool?.text) return tool;
    return preferred;
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

    const normalizedTarget = normalizeFeishuTarget(route?.target);
    const normalizedAccountId = normalizeAccountId(route?.accountId);
    const currentInboundTs = Math.max(Number(route?.lastVoiceInboundAt || 0), Number(route?.lastInboundAt || 0));
    const pendingReuseWindowMs = Math.max(1, Number(config.voiceReplyWindowMs || 0));
    if (normalizedTarget) {
      for (const [existingRunKey, pending] of store.pendingRunVoiceByKey.entries()) {
        if (!pending) continue;
        if (normalizeFeishuTarget(pending.target) !== normalizedTarget) continue;
        if (normalizeAccountId(pending.accountId) !== normalizedAccountId) continue;
        const pendingInboundTs = Math.max(Number(pending.lastVoiceInboundAt || 0), Number(pending.lastInboundAt || 0));
        const freshestInboundTs = Math.max(currentInboundTs, pendingInboundTs);
        if (freshestInboundTs <= 0) continue;
        if (Date.now() - freshestInboundTs > pendingReuseWindowMs) continue;
        const mergedAliases = Array.from(new Set([
          ...(Array.isArray(pending.aliases) ? pending.aliases : []),
          ...aliases
        ]));
        rememberPendingRunAliases(store, existingRunKey, mergedAliases);
        return {
          runKey: existingRunKey,
          aliases: mergedAliases
        };
      }
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
      dispatchAsyncImpl(() => flushRunVoiceReply(canonicalRunKey, reason));
      return;
    }

    pending.timer = setTimerImpl(() => {
      const latestPending = store.pendingRunVoiceByKey.get(canonicalRunKey);
      if (latestPending) latestPending.timer = null;
      void flushRunVoiceReply(canonicalRunKey, reason);
    }, waitMs);
    store.pendingRunVoiceByKey.set(canonicalRunKey, pending);
  }

  function schedulePendingFlush(runKey, pending) {
    if (!pending?.agentEnded) return;
    if (pending.hasFinalReply) {
      scheduleRunVoiceReplyFlush(runKey, "final_reply", config.voiceReplyDebounceMs);
      return;
    }
    if (pending.textSent) {
      scheduleRunVoiceReplyFlush(runKey, "agent_end", config.voiceReplyDebounceMs);
      return;
    }
    if (pending.textSending) {
      scheduleRunVoiceReplyFlush(runKey, "message_sending_fallback", config.voiceReplyTextSendingFallbackMs);
      return;
    }
    const hasInboundForNoTextFallback = pending.lastVoiceInboundAt > 0
      || (config.voiceReplyMode === "always" && pending.lastInboundAt > 0);
    const allowNoTextFallback = hasInboundForNoTextFallback
      && pending.hasAssistantMessage
      && (
        pending.transcriptEchoSkipped
        || config.voiceReplyMode === "always"
      );
    if (allowNoTextFallback) {
      scheduleRunVoiceReplyFlush(runKey, "no_text_fallback", config.voiceReplyNoTextFallbackMs);
    }
  }

  async function flushRunVoiceReply(runKey, reason) {
    if (
      reason !== "agent_end"
      && reason !== "final_reply"
      && reason !== "message_sending_fallback"
      && reason !== "no_text_fallback"
    ) return;

    const canonicalRunKey = resolveCanonicalRunKey(store, runKey);
    if (!canonicalRunKey) return;
    const pending = store.pendingRunVoiceByKey.get(canonicalRunKey);
    if (!pending) return;
    if (!pending.agentEnded) return;
    if (reason === "final_reply" && !pending.hasFinalReply) return;
    const usingFinalReply = reason === "final_reply";
    const usingTextSendingFallback = reason === "message_sending_fallback";
    const usingNoTextFallback = reason === "no_text_fallback";
    if (!pending.textSent) {
      if (usingFinalReply) {
        // before_agent_reply 已经给出最终文本时，不再要求 message_sent/text_sending 先落盘。
      } else if (usingTextSendingFallback) {
        if (!pending.textSending) return;
        const lastTextSendingAt = Number(pending.lastTextSendingAt || 0);
        if (lastTextSendingAt <= 0) return;
        if (Date.now() - lastTextSendingAt < Math.max(0, Number(config.voiceReplyTextSendingFallbackMs || 0))) {
          return;
        }
        api.logger?.info?.(`feishu-voice text_sent missing; using message_sending fallback (run=${canonicalRunKey}, target=${pending.target || "unknown"})`);
      } else if (usingNoTextFallback) {
        const noTextFallbackAllowed = (
          pending.lastVoiceInboundAt > 0
          || (config.voiceReplyMode === "always" && pending.lastInboundAt > 0)
        )
          && pending.hasAssistantMessage
          && (pending.transcriptEchoSkipped || config.voiceReplyMode === "always")
          && !pending.textSending;
        if (!noTextFallbackAllowed) return;
        api.logger?.info?.(`feishu-voice text hooks missing; using assistant fallback (run=${canonicalRunKey}, target=${pending.target || "unknown"}, transcriptEchoSkipped=${pending.transcriptEchoSkipped ? "yes" : "no"})`);
      } else {
        return;
      }
    }

    if (pending.timer) {
      clearTimerImpl(pending.timer);
      pending.timer = null;
    }
    const preferredReply = pending.preferredReply;
    const fallbackReply = pending.fallbackReply;
    const toolReply = pending.toolReply?.text ? pending.toolReply : null;
    // 语音内容优先跟随最终真正发出去的文字(message_sent)，
    // 如果拿不到 message_sent，则优先复用 tts 工具里的最终播报文案；
    // assistant_message 只作为最后兜底，避免把中间思考/进度文本播出来。
    const bestReply = chooseBestReply(preferredReply, fallbackReply, toolReply);
    const bestText = bestReply?.text || "";
    if (!bestText) return;
    if (shouldSkipVoiceReplyText(bestText)) return;

    store.pendingRunVoiceByKey.delete(canonicalRunKey);
    clearPendingRunAliases(store, canonicalRunKey, pending);

    const target = normalizeFeishuTarget(pending.target);
    const account = typeof pending.accountId === "string" && pending.accountId.trim() ? pending.accountId.trim() : "default";
    if (!target) return;
    const turnKey = buildVoiceTurnKey(
      account,
      target,
      pending.inboundMessageId || pending.replyToMessageId,
      Math.max(Number(pending.lastVoiceInboundAt || 0), Number(pending.lastInboundAt || 0))
    );
    if (hasCompletedVoiceTurn(turnKey)) {
      api.logger?.info?.(`feishu-voice skip auto reply: turn already completed (run=${canonicalRunKey}, turn=${turnKey})`);
      return;
    }

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

    const maxAttempts = Math.max(1, Number(config.voiceReplyRetryCount || 0) + 1);
    const retryBackoffMs = Math.max(0, Number(config.voiceReplyRetryBackoffMs || 0));
    const sendStartedAt = Date.now();

    const enqueueAttempt = (attempt) => enqueueBackgroundVoiceSend({
      runKey: canonicalRunKey,
      attempt,
      maxAttempts,
      execute: async () => {
        const attemptStartedAt = Date.now();
        try {
          if (preparedSpeech.summaryApplied) {
            api.logger?.info?.(`feishu-voice summarized voice reply (${preparedSpeech.sourceLength} chars -> ${speechText.length} chars, strategy=${preparedSpeech.summaryStrategy || "unknown"}, run=${canonicalRunKey})`);
          }
          const sent = await sendVoiceReplyImpl(config, api.logger, {
            chatId: target,
            text: speechText,
            audioArtifact: preparedSpeech.summaryApplied ? null : resolveAudioArtifactForSend(bestReply),
            replyToMessageId: pending.replyToMessageId,
            accountId: account
          });
          if (!sent) return;

          router.updateConversationRecords(conversationKeys, (nextRecord) => {
            nextRecord.lastVoiceReplyAt = Date.now();
            nextRecord.lastVoiceReplyText = speechText;
          });
          markCompletedVoiceTurn(turnKey);
          api.logger?.info?.(`feishu-voice auto reply sent (mode=${config.voiceReplyMode}, target=${target}, reason=${reason}, attempt=${attempt}/${maxAttempts}, sendMs=${Date.now() - attemptStartedAt}, endToEndMs=${Date.now() - sendStartedAt})`);
        } catch (err) {
          const detail = err && typeof err.message === "string" ? err.message : String(err);
          if (attempt < maxAttempts) {
            const retryDelayMs = retryBackoffMs * attempt;
            api.logger?.warn?.(`feishu-voice auto reply attempt failed; scheduling retry (run=${canonicalRunKey}, target=${target}, attempt=${attempt}/${maxAttempts}, retryInMs=${retryDelayMs}): ${detail}`);
            setTimerImpl(() => {
              enqueueAttempt(attempt + 1);
            }, retryDelayMs);
            return;
          }
          throw err;
        }
      }
    });

    enqueueAttempt(1);
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
      api.logger?.info?.(
        `feishu-voice skip ${source} capture: unresolved session target (run=${ctx?.runId || "none"}, session=${ctx?.sessionKey || "none"}, conversation=${ctx?.conversationId || "none"}, channel=${ctx?.channelId || "none"})`
      );
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
    next.inboundMessageId = route.inboundMessageId || route.replyToMessageId || next.inboundMessageId;
    next.lastInboundAt = Math.max(Number(next.lastInboundAt || 0), Number(route.lastInboundAt || 0));
    next.lastVoiceInboundAt = Math.max(Number(next.lastVoiceInboundAt || 0), Number(route.lastVoiceInboundAt || 0));
    next.sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : next.sessionKey;
    if (!next.agentEnded && wasAgentEndedRecently(ctx)) {
      next.agentEnded = true;
    }
    if (!next.textSent && next.sessionKey) {
      const lastTextSentAt = Number(store.textSentBySessionKey.get(next.sessionKey) || 0);
      if (lastTextSentAt > 0) {
        next.textSent = true;
      }
      const lastTextSendingAt = Number(store.textSendingBySessionKey.get(next.sessionKey) || 0);
      if (!next.textSending && lastTextSendingAt > 0) {
        next.textSending = true;
        next.lastTextSendingAt = Math.max(Number(next.lastTextSendingAt || 0), lastTextSendingAt);
      }
      if (!next.transcriptEchoSkipped && store.transcriptEchoSkippedBySessionKey.get(next.sessionKey)) {
        next.transcriptEchoSkipped = true;
      }
    }
    next.aliases = Array.from(new Set([...(Array.isArray(next.aliases) ? next.aliases : []), ...aliases]));
    next.conversationKeys = router.mergeConversationKeys(next.conversationKeys, route.conversationKeys);
    const turnKey = buildVoiceTurnKey(
      next.accountId,
      next.target,
      next.inboundMessageId || next.replyToMessageId,
      Math.max(Number(next.lastVoiceInboundAt || 0), Number(next.lastInboundAt || 0))
    );
    if (hasCompletedVoiceTurn(turnKey)) {
      api.logger?.info?.(`feishu-voice skip ${source} capture: turn already completed (run=${runKey}, turn=${turnKey})`);
      return;
    }

    const candidate = {
      text: normalizedText,
      audio: reply?.audio || null,
      source
    };

    if (source === "assistant_message" || source === "before_agent_reply") {
      next.hasAssistantMessage = true;
      if (source === "before_agent_reply") {
        next.hasFinalReply = true;
      }
      next.preferredReply = attachToolAudioIfMatched(
        mergeVoiceReplyCandidate(next.preferredReply, candidate),
        next.toolReply
      );
    } else if (source === "tts_tool") {
      next.toolReply = candidate;
    } else if (source === "message_sent") {
      // 用 message_sent 作为“文字已发出”的信号，保证语音回传发生在文字之后。
      next.textSent = true;
      next.fallbackReply = attachToolAudioIfMatched(
        mergeVoiceReplyCandidate(next.fallbackReply, candidate),
        next.toolReply
      );
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

    schedulePendingFlush(runKey, next);
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

  function clearPendingForSession(ctx, reason = "session_reset") {
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    if (!sessionKey) return;

    for (const [runKey, pending] of store.pendingRunVoiceByKey.entries()) {
      const matchesSession = pending?.sessionKey === sessionKey
        || (Array.isArray(pending?.aliases) && pending.aliases.includes(`session:${sessionKey}`));
      if (!matchesSession) continue;

      if (pending?.timer) clearTimerImpl(pending.timer);
      clearPendingRunAliases(store, runKey, pending);
      store.pendingRunVoiceByKey.delete(runKey);
      api.logger?.info?.(`feishu-voice cleared stale pending reply (run=${runKey}, reason=${reason})`);
    }
    clearRecentAgentEnd(ctx);
    store.textSendingBySessionKey.delete(sessionKey);
    store.textSentBySessionKey.delete(sessionKey);
    store.transcriptEchoSkippedBySessionKey.delete(sessionKey);
  }

  function markTextSending(ctx, replyText = "") {
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    const now = Date.now();
    if (replyText && isTranscriptEchoText?.(replyText)) {
      markTranscriptEchoSkipped(ctx, "message_sending");
      api.logger?.info?.("feishu-voice skip message_sending unlock/capture: transcript echo");
      return false;
    }
    if (sessionKey) {
      store.textSendingBySessionKey.set(sessionKey, now);
    }
    const route = router.resolveSessionTarget(ctx);
    const runKey = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";
    const normalizedText = normalizeSpeechText(replyText, config.maxCapturedReplyChars);
    const candidates = [
      runKey ? resolveCanonicalRunKey(store, runKey) : "",
      sessionKey ? resolveCanonicalRunKey(store, `session:${sessionKey}`) : "",
      route?.target ? resolveCanonicalRunKey(store, `target:${normalizeAccountId(route.accountId)}:${normalizeFeishuTarget(route.target)}`) : "",
      route?.replyToMessageId ? resolveCanonicalRunKey(store, `reply:${normalizeFeishuMessageId(route.replyToMessageId)}`) : ""
    ].filter(Boolean);

    for (const candidateKey of candidates) {
      const pending = store.pendingRunVoiceByKey.get(candidateKey);
      if (!pending) continue;
      pending.textSending = true;
      pending.lastTextSendingAt = now;
      if (normalizedText) {
        pending.fallbackReply = attachToolAudioIfMatched(
          mergeVoiceReplyCandidate(pending.fallbackReply, {
            text: normalizedText,
            audio: null,
            source: "message_sending"
          }),
          pending.toolReply
        );
      }
      if (route?.conversationKeys?.length) {
        pending.conversationKeys = router.mergeConversationKeys(pending.conversationKeys, route.conversationKeys);
      }
      store.pendingRunVoiceByKey.set(candidateKey, pending);
      api.logger?.info?.(`feishu-voice observed message_sending (run=${candidateKey}, target=${pending.target || route?.target || "unknown"})`);
      if (pending.agentEnded && !pending.textSent) {
        scheduleRunVoiceReplyFlush(candidateKey, "message_sending_fallback", config.voiceReplyTextSendingFallbackMs);
      }
      return true;
    }
    return false;
  }

  function markTextSent(ctx) {
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    if (sessionKey) {
      store.textSentBySessionKey.set(sessionKey, Date.now());
    }
    const route = router.resolveSessionTarget(ctx);
    const runKey = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";

    const candidates = [
      runKey ? resolveCanonicalRunKey(store, runKey) : "",
      sessionKey ? resolveCanonicalRunKey(store, `session:${sessionKey}`) : "",
      route?.target ? resolveCanonicalRunKey(store, `target:${normalizeAccountId(route.accountId)}:${normalizeFeishuTarget(route.target)}`) : "",
      route?.replyToMessageId ? resolveCanonicalRunKey(store, `reply:${normalizeFeishuMessageId(route.replyToMessageId)}`) : ""
    ].filter(Boolean);

    for (const candidateKey of candidates) {
      const pending = store.pendingRunVoiceByKey.get(candidateKey);
      if (!pending) continue;
      pending.textSent = true;
      if (route?.replyToMessageId && !pending.replyToMessageId) {
        pending.replyToMessageId = route.replyToMessageId;
      }
      if (route?.inboundMessageId && !pending.inboundMessageId) {
        pending.inboundMessageId = route.inboundMessageId;
      }
      if (route?.conversationKeys?.length) {
        pending.conversationKeys = router.mergeConversationKeys(pending.conversationKeys, route.conversationKeys);
      }
      store.pendingRunVoiceByKey.set(candidateKey, pending);
      api.logger?.info?.(`feishu-voice marked text_sent (run=${candidateKey}, target=${pending.target || route?.target || "unknown"})`);
      if (pending.agentEnded) {
        scheduleRunVoiceReplyFlush(candidateKey, "agent_end", config.voiceReplyDebounceMs);
      }
      return true;
    }
    return false;
  }

  function handleAgentEnd(event, ctx) {
    if (event?.success === false) {
      clearRecentAgentEnd(ctx);
    } else {
      rememberRecentAgentEnd(ctx);
    }

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
    // 先文字后语音：只有在 message_sent 之后才触发语音发送。
    schedulePendingFlush(effectiveRunKey, pending);
  }

  function handleMessageSent(event, ctx) {
    const text = extractMessageSentText(event);
    if (text && isTranscriptEchoText?.(text)) {
      markTranscriptEchoSkipped(ctx, "message_sent");
      api.logger?.info?.("feishu-voice skip message_sent unlock/capture: transcript echo");
      return false;
    }

    markTextSent(ctx);
    if (text && !shouldSkipVoiceReplyText(text)) {
      enqueueVoiceReply({ text }, ctx, "message_sent");
    }
    return true;
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
    clearRecentAgentEnd(ctx);
    store.textSendingBySessionKey.delete(sessionKey);
    store.textSentBySessionKey.delete(sessionKey);
    store.transcriptEchoSkippedBySessionKey.delete(sessionKey);
  }

  function markTranscriptEchoSkipped(ctx, source) {
    const route = router.resolveSessionTarget(ctx);
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    const runKey = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";
    if (sessionKey) {
      store.transcriptEchoSkippedBySessionKey.set(sessionKey, Date.now());
    }
    const candidates = [
      runKey ? resolveCanonicalRunKey(store, runKey) : "",
      sessionKey ? resolveCanonicalRunKey(store, `session:${sessionKey}`) : "",
      route?.target ? resolveCanonicalRunKey(store, `target:${normalizeAccountId(route.accountId)}:${normalizeFeishuTarget(route.target)}`) : "",
      route?.replyToMessageId ? resolveCanonicalRunKey(store, `reply:${normalizeFeishuMessageId(route.replyToMessageId)}`) : ""
    ].filter(Boolean);

    for (const candidateKey of candidates) {
      const pending = store.pendingRunVoiceByKey.get(candidateKey);
      if (!pending) continue;
      pending.transcriptEchoSkipped = true;
      store.pendingRunVoiceByKey.set(candidateKey, pending);
      api.logger?.info?.(`feishu-voice marked transcript echo skipped (run=${candidateKey}, source=${source}, target=${pending.target || route?.target || "unknown"})`);
      return true;
    }
    return false;
  }

  return {
    enqueueVoiceReply,
    flushRunVoiceReply,
    clearPendingForSession,
    handleAfterToolCall,
    handleAgentEnd,
    handleMessageSent,
    handleSessionEnd,
    markTextSending,
    markTextSent
  };
}

module.exports = {
  createVoiceReplyDispatcher
};
