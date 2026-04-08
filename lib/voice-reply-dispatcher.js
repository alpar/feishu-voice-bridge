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
  prunePendingVoiceReplyState,
  pruneStaleVoiceReplyState
} = require("./voice-reply-store");
const { isObservationOnlyRoute, shouldAllowWeakRouteReuse } = require("./voice-reply-route");
const { createVoiceTurnRepository } = require("./voice-turn-repository");
const {
  applySessionSignalsToPending,
  createPendingVoiceTurn,
  evaluatePendingFlushReadiness,
  mergePendingReplyCandidate,
  resolvePendingFlushPlan
} = require("./voice-turn-state-machine");

function createVoiceReplyDispatcher(params) {
  const { api, config, router, store, deps = {} } = params;
  const turnRepo = createVoiceTurnRepository(store);
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
  const stateTtlMs = Math.max(
    Number(config?.voiceReplyWindowMs || 0) * 3,
    60 * 60 * 1000
  );

  function pruneStore() {
    const now = Date.now();
    pruneStaleVoiceReplyState(store, now, stateTtlMs);
    prunePendingVoiceReplyState(store, now, stateTtlMs, {
      onDelete: (pending, runKey, reason) => {
        if (pending?.timer) clearTimerImpl(pending.timer);
        api.logger?.info?.(
          `feishu-voice pruned stale pending reply (run=${runKey}, reason=${reason}, target=${pending?.target || "unknown"})`
        );
      }
    });
  }

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
    turnRepo.markRecentAgentEnd(ctx, Math.max(config.voiceReplyWindowMs, 60_000));
  }

  function clearRecentAgentEnd(ctx) {
    turnRepo.clearRecentAgentEnd(ctx);
  }

  function wasAgentEndedRecently(ctx) {
    return turnRepo.wasAgentEndedRecently(ctx);
  }

  function hasCompletedVoiceTurn(turnKey) {
    return turnRepo.hasCompletedTurn(turnKey);
  }

  function markCompletedVoiceTurn(turnKey) {
    turnRepo.markCompletedTurn(turnKey, Math.max(config.voiceReplyWindowMs, 60_000));
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

  function buildReplyTextPreview(text, maxChars = 48) {
    const previewLimit = Math.max(8, Math.min(160, Number(maxChars) || 48));
    const normalized = normalizeSpeechText(text, previewLimit * 3);
    if (!normalized) return "";
    const singleLine = normalized.replace(/\s+/gu, " ").trim();
    if (!singleLine) return "";
    return singleLine.length > previewLimit
      ? `${singleLine.slice(0, previewLimit)}...`
      : singleLine;
  }

  function describeReplyCandidate(reply, label) {
    if (!reply?.text) return `${label}=none`;
    const normalized = normalizeSpeechText(reply.text, config.maxCapturedReplyChars);
    return `${label}=${reply.source || "unknown"}(chars=${normalized.length},audio=${reply.audio ? "yes" : "no"},preview=${buildReplyTextPreview(normalized) || "empty"})`;
  }

  function describePendingState(pending) {
    if (!pending) return "pending=none";
    return [
      describeReplyCandidate(pending.preferredReply, "preferred"),
      describeReplyCandidate(pending.fallbackReply, "fallback"),
      describeReplyCandidate(pending.toolReply, "tool"),
      `textSending=${pending.textSending ? "yes" : "no"}`,
      `textSent=${pending.textSent ? "yes" : "no"}`,
      `final=${pending.hasFinalReply ? "yes" : "no"}`,
      `assistant=${pending.hasAssistantMessage ? "yes" : "no"}`
    ].join(", ");
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
    // latest_route 只说明“最近给这个账号发过谁”，
    // 不代表当前事件真的属于上一轮 run，因此不能再借旧 reply/target 命中 pending。
    const allowWeakRouteReuse = shouldAllowWeakRouteReuse(route);
    const directAliases = aliases.filter((alias) => {
      if (alias.startsWith("target:")) return false;
      if (!allowWeakRouteReuse && alias.startsWith("reply:")) return false;
      return true;
    });
    for (const alias of directAliases) {
      const existingRunKey = turnRepo.findRunKeyByAlias(alias);
      if (!existingRunKey) continue;
      turnRepo.rememberRunAliases(existingRunKey, aliases);
      return {
        runKey: existingRunKey,
        aliases
      };
    }

    const normalizedTarget = normalizeFeishuTarget(route?.target);
    const normalizedAccountId = normalizeAccountId(route?.accountId);
    const currentSessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    const currentInboundMessageId = normalizeFeishuMessageId(route?.inboundMessageId || route?.replyToMessageId);
    const currentInboundTs = Math.max(Number(route?.lastVoiceInboundAt || 0), Number(route?.lastInboundAt || 0));
    const pendingReuseWindowMs = Math.max(1, Number(config.voiceReplyWindowMs || 0));
    if (normalizedTarget && allowWeakRouteReuse) {
      for (const [existingRunKey, pending] of turnRepo.iteratePendingEntries()) {
        if (!pending) continue;
        if (normalizeFeishuTarget(pending.target) !== normalizedTarget) continue;
        if (normalizeAccountId(pending.accountId) !== normalizedAccountId) continue;
        if (currentSessionKey && pending.sessionKey && pending.sessionKey !== currentSessionKey) continue;
        const pendingInboundMessageId = normalizeFeishuMessageId(pending.inboundMessageId || pending.replyToMessageId);
        const pendingInboundTs = Math.max(Number(pending.lastVoiceInboundAt || 0), Number(pending.lastInboundAt || 0));
        const sameInboundMoment = currentInboundTs > 0 && pendingInboundTs > 0 && currentInboundTs === pendingInboundTs;
        if (currentInboundMessageId && pendingInboundMessageId && pendingInboundMessageId !== currentInboundMessageId) continue;
        if (currentInboundMessageId && !pendingInboundMessageId && (pending.textSent || pending.hasFinalReply) && !sameInboundMoment) continue;
        const freshestInboundTs = Math.max(currentInboundTs, pendingInboundTs);
        if (freshestInboundTs <= 0) continue;
        if (Date.now() - freshestInboundTs > pendingReuseWindowMs) continue;
        if (currentInboundTs > 0 && pendingInboundTs > 0 && currentInboundTs !== pendingInboundTs && currentSessionKey !== pending.sessionKey) {
          continue;
        }
        const mergedAliases = Array.from(new Set([
          ...(Array.isArray(pending.aliases) ? pending.aliases : []),
          ...aliases
        ]));
        turnRepo.rememberRunAliases(existingRunKey, mergedAliases);
        api.logger?.info?.(
          `feishu-voice reused pending reply via target match (run=${existingRunKey}, target=${normalizedTarget}, session=${currentSessionKey || pending.sessionKey || "none"}, inbound=${currentInboundMessageId || currentInboundTs || "unknown"}, ${describePendingState(pending)})`
        );
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
    turnRepo.rememberRunAliases(fallbackKey, aliases);
    return {
      runKey: fallbackKey,
      aliases
    };
  }

  function clearPendingForInbound(ctx, reason = "new_inbound") {
    pruneStore();
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    const route = router.resolveSessionTarget(ctx);
    const target = normalizeFeishuTarget(route?.target);
    const accountId = normalizeAccountId(route?.accountId);

    for (const [runKey, pending] of turnRepo.iteratePendingEntries()) {
      const matchesSession = sessionKey
        && (
          pending?.sessionKey === sessionKey
          || (Array.isArray(pending?.aliases) && pending.aliases.includes(`session:${sessionKey}`))
        );
      const matchesTarget = target
        && normalizeFeishuTarget(pending?.target) === target
        && normalizeAccountId(pending?.accountId) === accountId;
      if (!matchesSession && !matchesTarget) continue;

      if (pending?.timer) clearTimerImpl(pending.timer);
      turnRepo.deletePending(runKey, pending);
      api.logger?.info?.(
        `feishu-voice cleared stale pending reply (run=${runKey}, reason=${reason}, target=${target || "unknown"}, session=${pending?.sessionKey || sessionKey || "none"}, ${describePendingState(pending)})`
      );
    }

    if (sessionKey) {
      clearRecentAgentEnd(ctx);
      turnRepo.clearSessionSignals(sessionKey);
    }
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
    const canonicalRunKey = turnRepo.resolveRunKey(runKey);
    if (!canonicalRunKey) return;

    const pending = turnRepo.getPending(canonicalRunKey);
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
      const latestPending = turnRepo.getPending(canonicalRunKey);
      if (latestPending) latestPending.timer = null;
      void flushRunVoiceReply(canonicalRunKey, reason);
    }, waitMs);
    turnRepo.setPending(canonicalRunKey, pending);
  }

  function schedulePendingFlush(runKey, pending) {
    const plan = resolvePendingFlushPlan(pending, config);
    if (!plan) return;
    scheduleRunVoiceReplyFlush(runKey, plan.reason, plan.delayMs);
  }

  async function flushRunVoiceReply(runKey, reason) {
    if (
      reason !== "agent_end"
      && reason !== "final_reply"
      && reason !== "message_sending_fallback"
      && reason !== "no_text_fallback"
    ) return;

    const canonicalRunKey = turnRepo.resolveRunKey(runKey);
    if (!canonicalRunKey) return;
    const pending = turnRepo.getPending(canonicalRunKey);
    if (!pending) return;
    if (!pending.agentEnded) return;
    if (reason === "final_reply" && !pending.hasFinalReply) return;
    const usingFinalReply = reason === "final_reply";
    const usingTextSendingFallback = reason === "message_sending_fallback";
    const usingNoTextFallback = reason === "no_text_fallback";
    if (!pending.textSent) {
      const readiness = evaluatePendingFlushReadiness(pending, reason, config, Date.now());
      if (!readiness.allowed) {
        if (usingFinalReply) {
          // before_agent_reply 已经给出最终文本时，不再要求 message_sent/text_sending 先落盘。
        } else {
          return;
        }
      } else if (readiness.fallbackMode === "message_sending") {
        api.logger?.info?.(`feishu-voice text_sent missing; using message_sending fallback (run=${canonicalRunKey}, target=${pending.target || "unknown"})`);
      } else if (readiness.fallbackMode === "assistant") {
        api.logger?.info?.(`feishu-voice text hooks missing; using assistant fallback (run=${canonicalRunKey}, target=${pending.target || "unknown"}, transcriptEchoSkipped=${pending.transcriptEchoSkipped ? "yes" : "no"})`);
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
    const selection = chooseBestReply(preferredReply, fallbackReply, toolReply);
    const bestReply = selection.reply;
    const bestText = bestReply?.text || "";
    if (!bestText) return;
    if (shouldSkipVoiceReplyText(bestText)) return;
    api.logger?.info?.(
      `feishu-voice reply decision (run=${canonicalRunKey}, reason=${reason}, target=${pending.target || "unknown"}, selected=${bestReply?.source || "none"}, selectedReason=${selection.reason}, ${describeReplyCandidate(selection.preferred, "preferred")}, ${describeReplyCandidate(selection.fallback, "fallback")}, ${describeReplyCandidate(selection.tool, "tool")}, selectedPreview=${buildReplyTextPreview(bestText) || "empty"})`
    );

    turnRepo.deletePending(canonicalRunKey, pending);

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
      loadSpeechRuntime: typeof config.runtime?.getSpeechRuntime === "function"
        ? () => config.runtime.getSpeechRuntime()
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
          api.logger?.info?.(`feishu-voice auto reply sent (mode=${config.voiceReplyMode}, target=${target}, reason=${reason}, selected=${bestReply?.source || "none"}, speechChars=${speechText.length}, speechPreview=${buildReplyTextPreview(speechText) || "empty"}, attempt=${attempt}/${maxAttempts}, sendMs=${Date.now() - attemptStartedAt}, endToEndMs=${Date.now() - sendStartedAt})`);
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
    pruneStore();
    if (config.voiceReplyEnabled !== true || config.voiceReplyMode === "off") return;
    const rawText = typeof reply?.text === "string" ? reply.text : "";
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    if (source === "message_sent" && isTranscriptEchoText?.(rawText)) {
      api.logger?.info?.("feishu-voice skip message_sent capture: transcript echo");
      return;
    }
    const normalizedText = normalizeSpeechText(reply?.text, config.maxCapturedReplyChars);
    if (!normalizedText) return;
    if (source === "before_agent_reply" && sessionKey) {
      if (turnRepo.wasTranscriptEchoSkipped(sessionKey)) {
        api.logger?.info?.("feishu-voice skip before_agent_reply capture: transcript echo session");
        return;
      }
      const skippedTranscriptEchoText = turnRepo.getTranscriptEchoText(sessionKey);
      if (sameOrNestedText(normalizedText, skippedTranscriptEchoText)) {
        api.logger?.info?.("feishu-voice skip before_agent_reply capture: transcript echo");
        return;
      }
    }

    const route = router.resolveSessionTarget(ctx);
    if (!route?.target) {
      api.logger?.info?.(
        `feishu-voice skip ${source} capture: unresolved session target (run=${ctx?.runId || "none"}, session=${ctx?.sessionKey || "none"}, conversation=${ctx?.conversationId || "none"}, channel=${ctx?.channelId || "none"})`
      );
      return;
    }
    if (isObservationOnlyRoute(route)) {
      api.logger?.info?.(
        `feishu-voice skip ${source} capture: latest_route is observation-only (run=${ctx?.runId || "none"}, session=${ctx?.sessionKey || "none"}, target=${route.target || "unknown"})`
      );
      return;
    }
    if (source === "before_agent_reply" && Number(route.lastVoiceInboundAt || 0) > 0) {
      api.logger?.info?.("feishu-voice skip before_agent_reply capture: voice inbound session");
      return;
    }

    const { runKey, aliases } = resolvePendingRunKey(ctx, route);
    const existing = turnRepo.getPending(runKey);
    if (existing?.timer) clearTimerImpl(existing.timer);

    const next = existing || createPendingVoiceTurn(route);
    next.target = route.target;
    next.accountId = route.accountId;
    next.replyToMessageId = route.replyToMessageId || next.replyToMessageId;
    next.inboundMessageId = route.inboundMessageId || route.replyToMessageId || next.inboundMessageId;
    next.lastInboundAt = Math.max(Number(next.lastInboundAt || 0), Number(route.lastInboundAt || 0));
    next.lastVoiceInboundAt = Math.max(Number(next.lastVoiceInboundAt || 0), Number(route.lastVoiceInboundAt || 0));
    next.sessionKey = sessionKey || next.sessionKey;
    applySessionSignalsToPending(next, {
      agentEndedRecently: wasAgentEndedRecently(ctx),
      lastTextSentAt: next.sessionKey ? turnRepo.getTextSentAt(next.sessionKey) : 0,
      lastTextSendingAt: next.sessionKey ? turnRepo.getTextSendingAt(next.sessionKey) : 0,
      transcriptEchoSkipped: next.sessionKey ? turnRepo.wasTranscriptEchoSkipped(next.sessionKey) : false
    });
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

    mergePendingReplyCandidate(next, source, candidate, {
      attachToolAudioIfMatched
    });

    if (next.timer) {
      clearTimerImpl(next.timer);
      next.timer = null;
    }
    turnRepo.setPending(runKey, next);
    turnRepo.rememberRunAliases(runKey, next.aliases);
    api.logger?.info?.(`feishu-voice captured ${source} text (run=${runKey}, target=${route.target}, preferred=${next.preferredReply?.text ? "yes" : "no"}, audio=${candidate.audio ? "yes" : "no"})`);

    schedulePendingFlush(runKey, next);
  }

  function handleAfterToolCall(event, ctx) {
    if (event?.toolName !== "tts" || event?.error) return;
    const route = router.resolveSessionTarget(ctx);
    if (Number(route?.lastVoiceInboundAt || 0) > 0) {
      api.logger?.info?.("feishu-voice skip tts_tool capture: voice inbound session");
      return;
    }

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
    pruneStore();
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    if (!sessionKey) return;

    for (const [runKey, pending] of turnRepo.iteratePendingEntries()) {
      const matchesSession = pending?.sessionKey === sessionKey
        || (Array.isArray(pending?.aliases) && pending.aliases.includes(`session:${sessionKey}`));
      if (!matchesSession) continue;

      if (pending?.timer) clearTimerImpl(pending.timer);
      turnRepo.deletePending(runKey, pending);
      api.logger?.info?.(`feishu-voice cleared stale pending reply (run=${runKey}, reason=${reason})`);
    }
    clearRecentAgentEnd(ctx);
    turnRepo.clearSessionSignals(sessionKey);
  }

  function buildPendingLookupKeys(ctx, route, options = {}) {
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    const runKey = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";
    const allowWeakRouteAliases = options.allowWeakRouteAliases !== false && !isObservationOnlyRoute(route);
    return [
      runKey ? turnRepo.resolveRunKey(runKey) : "",
      sessionKey ? turnRepo.resolveRunKey(`session:${sessionKey}`) : "",
      allowWeakRouteAliases && route?.target ? turnRepo.resolveRunKey(`target:${normalizeAccountId(route.accountId)}:${normalizeFeishuTarget(route.target)}`) : "",
      allowWeakRouteAliases && route?.replyToMessageId ? turnRepo.resolveRunKey(`reply:${normalizeFeishuMessageId(route.replyToMessageId)}`) : ""
    ].filter(Boolean);
  }

  function markTextSending(ctx, replyText = "") {
    pruneStore();
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    const now = Date.now();
    if (replyText && isTranscriptEchoText?.(replyText)) {
      markTranscriptEchoSkipped(ctx, "message_sending", replyText);
      api.logger?.info?.("feishu-voice skip message_sending unlock/capture: transcript echo");
      return false;
    }
    if (sessionKey) {
      turnRepo.setTextSendingAt(sessionKey, now);
    }
    const route = router.resolveSessionTarget(ctx);
    const normalizedText = normalizeSpeechText(replyText, config.maxCapturedReplyChars);
    const candidates = buildPendingLookupKeys(ctx, route);

    for (const candidateKey of candidates) {
      const pending = turnRepo.getPending(candidateKey);
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
      turnRepo.setPending(candidateKey, pending);
      api.logger?.info?.(`feishu-voice observed message_sending (run=${candidateKey}, target=${pending.target || route?.target || "unknown"})`);
      if (pending.agentEnded && !pending.textSent) {
        scheduleRunVoiceReplyFlush(candidateKey, "message_sending_fallback", config.voiceReplyTextSendingFallbackMs);
      }
      return true;
    }
    return false;
  }

  function markTextSent(ctx) {
    pruneStore();
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    if (sessionKey) {
      turnRepo.setTextSentAt(sessionKey, Date.now());
    }
    const route = router.resolveSessionTarget(ctx);
    const candidates = buildPendingLookupKeys(ctx, route);

    for (const candidateKey of candidates) {
      const pending = turnRepo.getPending(candidateKey);
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
      turnRepo.setPending(candidateKey, pending);
      api.logger?.info?.(`feishu-voice marked text_sent (run=${candidateKey}, target=${pending.target || route?.target || "unknown"})`);
      if (pending.agentEnded) {
        scheduleRunVoiceReplyFlush(candidateKey, "agent_end", config.voiceReplyDebounceMs);
      }
      return true;
    }
    return false;
  }

  function handleAgentEnd(event, ctx) {
    pruneStore();
    if (event?.success === false) {
      clearRecentAgentEnd(ctx);
    } else {
      rememberRecentAgentEnd(ctx);
    }

    const runKey = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    const canonicalRunKey = runKey ? turnRepo.resolveRunKey(runKey) : "";
    const hasCanonicalPending = canonicalRunKey ? turnRepo.hasPending(canonicalRunKey) : false;
    const fallbackSessionRunKey = sessionKey ? turnRepo.resolveRunKey(`session:${sessionKey}`) : "";
    const hasSessionPending = fallbackSessionRunKey ? turnRepo.hasPending(fallbackSessionRunKey) : false;
    const effectiveRunKey = hasCanonicalPending
      ? canonicalRunKey
      : hasSessionPending
        ? fallbackSessionRunKey
        : canonicalRunKey || fallbackSessionRunKey;

    if (!effectiveRunKey) {
      api.logger?.info?.("feishu-voice skip agent_end flush: missing run/session target");
      return;
    }

    const pending = turnRepo.getPending(effectiveRunKey);
    if (pending && event?.success === false) {
      if (pending.timer) clearTimerImpl(pending.timer);
      turnRepo.deletePending(effectiveRunKey, pending);
      api.logger?.info?.(`feishu-voice cleared pending reply after unsuccessful agent_end (run=${effectiveRunKey})`);
      return;
    }

    if (pending) {
      pending.agentEnded = true;
      turnRepo.setPending(effectiveRunKey, pending);
    }
    // 先文字后语音：只有在 message_sent 之后才触发语音发送。
    schedulePendingFlush(effectiveRunKey, pending);
  }

  function handleMessageSent(event, ctx) {
    pruneStore();
    const text = extractMessageSentText(event);
    if (text && isTranscriptEchoText?.(text)) {
      markTranscriptEchoSkipped(ctx, "message_sent", text);
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
    pruneStore();
    const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
    if (!sessionKey) return;

    for (const [runKey, pending] of turnRepo.iteratePendingEntries()) {
      if (pending?.sessionKey === sessionKey || Array.isArray(pending?.aliases) && pending.aliases.includes(`session:${sessionKey}`)) {
        if (pending?.timer) clearTimerImpl(pending.timer);
        turnRepo.deletePending(runKey, pending);
      }
    }
    router.clearSession(sessionKey);
    clearRecentAgentEnd(ctx);
    turnRepo.clearSessionSignals(sessionKey);
  }

  function markTranscriptEchoSkipped(ctx, source, text = "") {
    pruneStore();
    const route = router.resolveSessionTarget(ctx);
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    if (sessionKey) {
      const normalizedText = normalizeSpeechText(text, config.maxCapturedReplyChars);
      turnRepo.markTranscriptEchoSkipped(sessionKey, normalizedText, Date.now());
    }
    const candidates = buildPendingLookupKeys(ctx, route);

    for (const candidateKey of candidates) {
      const pending = turnRepo.getPending(candidateKey);
      if (!pending) continue;
      pending.transcriptEchoSkipped = true;
      turnRepo.setPending(candidateKey, pending);
      api.logger?.info?.(`feishu-voice marked transcript echo skipped (run=${candidateKey}, source=${source}, target=${pending.target || route?.target || "unknown"})`);
      return true;
    }
    return false;
  }

  return {
    clearPendingForInbound,
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
