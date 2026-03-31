"use strict";

const { FEISHU_TEXT_TTS_PROMPT } = require("./constants");
const { sendVoiceReply } = require("./audio");
const {
  inferTargetFromSessionKey,
  isFeishuChannelContext,
  isVoiceInboundEvent,
  normalizeAccountId,
  normalizeFeishuMessageId,
  normalizeFeishuTarget,
  resolveFeishuMessageIdFromEventOrContext,
  resolveFeishuTargetFromEventOrContext
} = require("./feishu");
const {
  buildTranscriptEchoMatcher,
  extractAssistantTextFromAgentMessage,
  isProgressLikeVoiceReplyText,
  mergeVoiceReplyCandidate,
  normalizeSpeechText,
  prepareVoiceReplyText,
  shouldSkipVoiceReplyText
} = require("./text");

function registerVoiceReplyHooks(api, config, deps = {}) {
  if (typeof api?.on !== "function") return;

  // 这几个 Map 是语音桥接的核心状态：
  // - stateByConversation: 会话级时间窗与去重信息
  // - latestInboundByTarget: 最近一次入站消息元数据
  // - sessionTargetBySessionKey: 稀疏上下文时的目标映射
  // - pendingRunVoiceByKey / pendingRunAliasToKey: 一次 agent run 内待发送的语音回复
  const stateByConversation = new Map();
  const latestInboundByTarget = new Map();
  const sessionTargetBySessionKey = new Map();
  const pendingRunVoiceByKey = new Map();
  const pendingRunAliasToKey = new Map();
  const sendVoiceReplyImpl = typeof deps.sendVoiceReplyImpl === "function" ? deps.sendVoiceReplyImpl : sendVoiceReply;
  const clearTimerImpl = typeof deps.clearTimer === "function" ? deps.clearTimer : clearTimeout;
  const isTranscriptEchoText = buildTranscriptEchoMatcher(config);

  const getConversationKeys = (ctx, targets) => {
    const account = typeof ctx?.accountId === "string" && ctx.accountId.trim() ? ctx.accountId.trim() : "default";
    const keys = new Set();
    const add = (value) => {
      const normalized = normalizeFeishuTarget(value);
      if (!normalized) return;
      keys.add(`${account}:${normalized}`);
    };

    add(ctx?.conversationId);
    add(ctx?.chatId);
    if (Array.isArray(targets)) {
      for (const value of targets) add(value);
    }
    return Array.from(keys);
  };

  const touchConversationRecords = (ctx, targets, mutate) => {
    const keys = getConversationKeys(ctx, targets);
    for (const key of keys) {
      const record = stateByConversation.get(key) || {};
      mutate(record);
      stateByConversation.set(key, record);
    }
    return keys;
  };

  const mergeConversationKeys = (...groups) => {
    const merged = new Set();
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      for (const key of group) {
        if (typeof key === "string" && key.trim()) merged.add(key.trim());
      }
    }
    return Array.from(merged);
  };

  // 同一个会话可能同时命中多个 key，这里合并读取，保证节流和去重判断用的是最新状态。
  const readConversationRecord = (keys) => {
    const merged = {};
    for (const key of Array.isArray(keys) ? keys : []) {
      const record = stateByConversation.get(key);
      if (!record || typeof record !== "object") continue;
      if (Number(record.lastInboundAt || 0) > Number(merged.lastInboundAt || 0)) {
        merged.lastInboundAt = Number(record.lastInboundAt || 0);
      }
      if (Number(record.lastVoiceInboundAt || 0) > Number(merged.lastVoiceInboundAt || 0)) {
        merged.lastVoiceInboundAt = Number(record.lastVoiceInboundAt || 0);
      }
      if (Number(record.lastOutboundAt || 0) > Number(merged.lastOutboundAt || 0)) {
        merged.lastOutboundAt = Number(record.lastOutboundAt || 0);
      }
      if (Number(record.lastVoiceReplyAt || 0) > Number(merged.lastVoiceReplyAt || 0)) {
        merged.lastVoiceReplyAt = Number(record.lastVoiceReplyAt || 0);
        merged.lastVoiceReplyText = typeof record.lastVoiceReplyText === "string" ? record.lastVoiceReplyText : merged.lastVoiceReplyText;
      }
    }
    return merged;
  };

  const updateConversationRecords = (keys, mutate) => {
    for (const key of Array.isArray(keys) ? keys : []) {
      const record = stateByConversation.get(key) || {};
      mutate(record);
      stateByConversation.set(key, record);
    }
  };

  const getLatestInboundKey = (accountId, target) => {
    const normalizedTarget = normalizeFeishuTarget(target);
    if (!normalizedTarget) return "";
    return `${normalizeAccountId(accountId)}:${normalizedTarget}`;
  };

  const rememberLatestInbound = (accountId, target, patch) => {
    const key = getLatestInboundKey(accountId, target);
    if (!key) return;
    const existing = latestInboundByTarget.get(key) || {};
    latestInboundByTarget.set(key, {
      ...existing,
      ...patch
    });
  };

  const readLatestInbound = (accountId, target) => {
    const key = getLatestInboundKey(accountId, target);
    return key ? (latestInboundByTarget.get(key) || null) : null;
  };

  // 不同事件拿到的 run 标识并不稳定，所以用 alias 把 run / reply / session / target 串起来。
  const buildPendingRunAliases = (ctx, route) => {
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
  };

  const rememberPendingRunAliases = (runKey, aliases) => {
    for (const alias of Array.isArray(aliases) ? aliases : []) {
      if (typeof alias === "string" && alias.trim()) pendingRunAliasToKey.set(alias, runKey);
    }
  };

  const resolvePendingRunKey = (ctx, route) => {
    const aliases = buildPendingRunAliases(ctx, route);
    for (const alias of aliases) {
      const existingRunKey = pendingRunAliasToKey.get(alias);
      if (!existingRunKey) continue;
      rememberPendingRunAliases(existingRunKey, aliases);
      return {
        runKey: existingRunKey,
        aliases
      };
    }

    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    const replyToMessageId = normalizeFeishuMessageId(route?.replyToMessageId);
    const runId = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";
    const fallbackKey = runId || (replyToMessageId ? `reply:${replyToMessageId}` : `${sessionKey || route?.target || "voice"}:fallback-run`);
    rememberPendingRunAliases(fallbackKey, aliases);
    return {
      runKey: fallbackKey,
      aliases
    };
  };

  const resolveCanonicalRunKey = (runKeyOrAlias) => {
    if (typeof runKeyOrAlias !== "string" || !runKeyOrAlias.trim()) return "";
    const normalizedKey = runKeyOrAlias.trim();
    const replyAlias = normalizeFeishuMessageId(normalizedKey);
    return pendingRunAliasToKey.get(normalizedKey)
      || pendingRunAliasToKey.get(`run:${normalizedKey}`)
      || (replyAlias ? pendingRunAliasToKey.get(`reply:${replyAlias}`) : "")
      || pendingRunAliasToKey.get(`session:${normalizedKey}`)
      || normalizedKey;
  };

  const clearPendingRunAliases = (runKey, pending) => {
    for (const alias of Array.isArray(pending?.aliases) ? pending.aliases : []) {
      if (pendingRunAliasToKey.get(alias) === runKey) {
        pendingRunAliasToKey.delete(alias);
      }
    }
  };

  const markInboundVoice = (event, ctx) => {
    if (!isFeishuChannelContext(ctx)) return;
    const target = resolveFeishuTargetFromEventOrContext(event, ctx);
    const accountId = typeof ctx?.accountId === "string" && ctx.accountId.trim() ? ctx.accountId.trim() : "default";
    const now = Date.now();
    const keys = touchConversationRecords(ctx, [target, event?.chatId, event?.metadata?.to], (record) => {
      record.lastInboundAt = now;
    });
    if (keys.length === 0) return;

    rememberLatestInbound(accountId, target, {
      lastInboundAt: now
    });

    if (!isVoiceInboundEvent(event)) return;

    touchConversationRecords(ctx, [target, event?.chatId, event?.metadata?.to], (record) => {
      record.lastVoiceInboundAt = now;
    });
    rememberLatestInbound(accountId, target, {
      lastInboundAt: now,
      lastVoiceInboundAt: now
    });
    api.logger?.info?.(`feishu-voice inbound voice marked (target=${target || "unknown"}, keys=${keys.join(",")})`);
  };

  const rememberSessionTarget = (ctx, event) => {
    if (!isFeishuChannelContext(ctx)) return;
    const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
    if (!sessionKey) return;

    const target = resolveFeishuTargetFromEventOrContext(event, ctx);
    const replyToMessageId = resolveFeishuMessageIdFromEventOrContext(event, ctx);
    if (!target) return;

    const conversationKeys = getConversationKeys(ctx, [
      target,
      event?.chatId,
      event?.metadata?.to,
      inferTargetFromSessionKey(sessionKey)
    ]);
    const existing = sessionTargetBySessionKey.get(sessionKey);

    sessionTargetBySessionKey.set(sessionKey, {
      target,
      accountId: typeof ctx?.accountId === "string" && ctx.accountId.trim() ? ctx.accountId.trim() : "default",
      replyToMessageId: replyToMessageId || existing?.replyToMessageId || "",
      conversationKeys: mergeConversationKeys(existing?.conversationKeys, conversationKeys),
      updatedAt: Date.now()
    });
    rememberLatestInbound(
      typeof ctx?.accountId === "string" && ctx.accountId.trim() ? ctx.accountId.trim() : "default",
      target,
      {
        replyToMessageId: replyToMessageId || existing?.replyToMessageId || ""
      }
    );
  };

  api.on("before_prompt_build", (_event, ctx) => {
    if (!config.voiceReplyEnabled || config.voiceReplyMode === "off") return;
    if (!config.promptToolTtsForText) return;
    if (!isFeishuChannelContext(ctx)) return;
    return {
      appendSystemContext: FEISHU_TEXT_TTS_PROMPT
    };
  });

  api.on("inbound_claim", (event, ctx) => {
    rememberSessionTarget(ctx, event);
    markInboundVoice(event, ctx);
  });

  api.on("message_received", (event, ctx) => {
    rememberSessionTarget(ctx, event);
    markInboundVoice(event, ctx);
  });

  api.on("before_dispatch", (event, ctx) => {
    rememberSessionTarget(ctx, event);
    markInboundVoice(event, ctx);
  });

  const shouldAllowConversationVoiceReply = (record) => {
    if (config.voiceReplyMode !== "inbound") return true;
    const now = Date.now();
    const lastVoiceInboundAt = Number(record?.lastVoiceInboundAt || 0);
    const lastInboundAt = Number(record?.lastInboundAt || 0);
    const gatingTs = Math.max(lastVoiceInboundAt, lastInboundAt);
    if (!gatingTs || now - gatingTs > config.voiceReplyWindowMs) return false;
    return true;
  };

  // 真正发语音只在 agent_end 触发，避免把中间态文本或进度提示过早播出去。
  const flushRunVoiceReply = async (runKey, reason) => {
    if (reason !== "agent_end") return;

    const canonicalRunKey = resolveCanonicalRunKey(runKey);
    if (!canonicalRunKey) return;
    const pending = pendingRunVoiceByKey.get(canonicalRunKey);
    if (!pending) return;

    if (pending.timer) {
      clearTimerImpl(pending.timer);
      pending.timer = null;
    }
    pendingRunVoiceByKey.delete(canonicalRunKey);
    clearPendingRunAliases(canonicalRunKey, pending);

    const bestReply = pending.preferredReply?.text ? pending.preferredReply : pending.fallbackReply;
    const bestText = bestReply?.text || "";
    if (!bestText) return;
    if (shouldSkipVoiceReplyText(bestText)) return;

    const target = normalizeFeishuTarget(pending.target);
    const account = typeof pending.accountId === "string" && pending.accountId.trim() ? pending.accountId.trim() : "default";
    if (!target) return;

    const conversationKeys = mergeConversationKeys(
      pending.conversationKeys,
      [`${account}:${target}`]
    );
    const logKey = conversationKeys.join(",") || `${account}:${target}`;
    const record = readConversationRecord(conversationKeys);
    const allowByInboundGate = shouldAllowConversationVoiceReply(record);
    const allowByCurrentInbound = config.voiceReplyMode === "inbound" && !!pending.replyToMessageId;
    const allowByReplyFallback = config.voiceReplyMode === "inbound" && reason === "agent_end" && !!pending.replyToMessageId;
    const pendingInboundTs = Math.max(Number(pending.lastVoiceInboundAt || 0), Number(pending.lastInboundAt || 0));
    const allowByPendingInbound = config.voiceReplyMode === "inbound"
      && pendingInboundTs > 0
      && Date.now() - pendingInboundTs <= config.voiceReplyWindowMs;

    if (!allowByInboundGate && !allowByCurrentInbound && !allowByReplyFallback && !allowByPendingInbound) {
      api.logger?.info?.(`feishu-voice skip auto reply: inbound gate closed (run=${canonicalRunKey}, reason=${reason}, key=${logKey})`);
      return;
    }

    if (!allowByInboundGate && (allowByCurrentInbound || allowByReplyFallback || allowByPendingInbound)) {
      const fallbackReason = allowByCurrentInbound && reason !== "agent_end"
        ? "current_inbound"
        : allowByReplyFallback
          ? "reply_fallback"
          : "pending_inbound";
      api.logger?.info?.(`feishu-voice inbound gate fallback open (run=${canonicalRunKey}, reason=${reason}, mode=${fallbackReason}, key=${logKey}, replyTo=${pending.replyToMessageId})`);
    }

    const preparedSpeech = prepareVoiceReplyText(bestText, config);
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
        api.logger?.info?.(`feishu-voice summarized voice reply (${preparedSpeech.sourceLength} chars -> ${speechText.length} chars, run=${canonicalRunKey})`);
      }
      const sent = await sendVoiceReplyImpl(config, api.logger, {
        chatId: target,
        text: speechText,
        audioArtifact: preparedSpeech.summaryApplied ? null : bestReply?.audio || null,
        replyToMessageId: pending.replyToMessageId,
        accountId: account
      });
      if (!sent) return;

      updateConversationRecords(conversationKeys, (nextRecord) => {
        nextRecord.lastVoiceReplyAt = now;
        nextRecord.lastVoiceReplyText = speechText;
      });
      api.logger?.info?.(`feishu-voice auto reply sent (mode=${config.voiceReplyMode}, target=${target}, reason=${reason})`);
    } catch (err) {
      const detail = err && typeof err.message === "string" ? err.message : String(err);
      api.logger?.warn?.(`feishu-voice auto reply failed: ${detail}`);
    }
  };

  // 某些回调上下文很稀疏，因此这里尽量从当前事件、session 记忆和最近入站记录里补足目标信息。
  const resolveSessionTarget = (ctx) => {
    const currentTarget = resolveFeishuTargetFromEventOrContext(null, ctx);
    const currentReplyToMessageId = resolveFeishuMessageIdFromEventOrContext(null, ctx);
    if (currentTarget) {
      const remembered = typeof ctx?.sessionKey === "string" ? sessionTargetBySessionKey.get(ctx.sessionKey) : null;
      const accountId = typeof ctx?.accountId === "string" && ctx.accountId.trim() ? ctx.accountId.trim() : "default";
      const latestInbound = readLatestInbound(accountId, currentTarget);
      return {
        target: currentTarget,
        accountId,
        replyToMessageId: currentReplyToMessageId || remembered?.replyToMessageId || latestInbound?.replyToMessageId || "",
        lastInboundAt: Number(latestInbound?.lastInboundAt || 0),
        lastVoiceInboundAt: Number(latestInbound?.lastVoiceInboundAt || 0),
        conversationKeys: mergeConversationKeys(
          remembered?.conversationKeys,
          getConversationKeys(ctx, [currentTarget, remembered?.target, inferTargetFromSessionKey(ctx?.sessionKey)])
        )
      };
    }

    const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
    if (!sessionKey) return null;
    const remembered = sessionTargetBySessionKey.get(sessionKey);
    if (remembered?.target) {
      const accountId = typeof ctx?.accountId === "string" && ctx.accountId.trim() ? ctx.accountId.trim() : remembered.accountId || "default";
      const latestInbound = readLatestInbound(accountId, remembered.target);
      return {
        ...remembered,
        accountId,
        replyToMessageId: remembered.replyToMessageId || latestInbound?.replyToMessageId || "",
        lastInboundAt: Number(latestInbound?.lastInboundAt || 0),
        lastVoiceInboundAt: Number(latestInbound?.lastVoiceInboundAt || 0)
      };
    }

    const inferred = inferTargetFromSessionKey(sessionKey);
    if (!inferred) return null;
    const accountId = typeof ctx?.accountId === "string" && ctx.accountId.trim() ? ctx.accountId.trim() : "default";
    const latestInbound = readLatestInbound(accountId, inferred);
    return {
      target: inferred,
      accountId,
      replyToMessageId: currentReplyToMessageId || latestInbound?.replyToMessageId || "",
      lastInboundAt: Number(latestInbound?.lastInboundAt || 0),
      lastVoiceInboundAt: Number(latestInbound?.lastVoiceInboundAt || 0),
      conversationKeys: getConversationKeys(ctx, [inferred])
    };
  };

  // 所有候选回复先入队，等 agent_end 再决定最终播哪一条。
  const enqueueVoiceReply = (reply, ctx, source) => {
    if (config.voiceReplyEnabled !== true || config.voiceReplyMode === "off") return;
    const normalizedText = normalizeSpeechText(reply?.text, config.maxCapturedReplyChars);
    if (!normalizedText) return;
    if (source === "message_sent" && isTranscriptEchoText?.(normalizedText)) {
      api.logger?.info?.("feishu-voice skip message_sent capture: transcript echo");
      return;
    }

    const route = resolveSessionTarget(ctx);
    if (!route?.target) {
      api.logger?.info?.(`feishu-voice skip ${source} capture: unresolved session target`);
      return;
    }

    const { runKey, aliases } = resolvePendingRunKey(ctx, route);
    const existing = pendingRunVoiceByKey.get(runKey);
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
    next.conversationKeys = mergeConversationKeys(next.conversationKeys, route.conversationKeys);

    const candidate = {
      text: normalizedText,
      audio: reply?.audio || null,
      source
    };

    if (source === "assistant_message") {
      next.hasAssistantMessage = true;
      next.preferredReply = mergeVoiceReplyCandidate(next.preferredReply, candidate);
    } else if (isProgressLikeVoiceReplyText(normalizedText)) {
      next.fallbackReply = mergeVoiceReplyCandidate(next.fallbackReply, candidate);
    } else {
      next.fallbackReply = mergeVoiceReplyCandidate(next.fallbackReply, candidate);
    }

    if (next.timer) {
      clearTimerImpl(next.timer);
      next.timer = null;
    }
    pendingRunVoiceByKey.set(runKey, next);
    rememberPendingRunAliases(runKey, next.aliases);
    api.logger?.info?.(`feishu-voice captured ${source} text (run=${runKey}, target=${route.target}, preferred=${next.preferredReply?.text ? "yes" : "no"}, audio=${candidate.audio ? "yes" : "no"})`);
  };

  api.on("before_message_write", (event, ctx) => {
    const text = extractAssistantTextFromAgentMessage(event?.message);
    if (!text) return;
    enqueueVoiceReply({ text }, {
      accountId: typeof ctx?.accountId === "string" ? ctx.accountId : undefined,
      sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined
    }, "assistant_message");
  });

  api.on("agent_end", (event, ctx) => {
    const runKey = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "";
    const canonicalRunKey = runKey ? resolveCanonicalRunKey(runKey) : "";
    const hasCanonicalPending = canonicalRunKey ? pendingRunVoiceByKey.has(canonicalRunKey) : false;
    const fallbackSessionRunKey = sessionKey ? resolveCanonicalRunKey(`session:${sessionKey}`) : "";
    const hasSessionPending = fallbackSessionRunKey ? pendingRunVoiceByKey.has(fallbackSessionRunKey) : false;
    const effectiveRunKey = hasCanonicalPending
      ? canonicalRunKey
      : hasSessionPending
        ? fallbackSessionRunKey
        : canonicalRunKey || fallbackSessionRunKey;

    if (!effectiveRunKey) {
      api.logger?.info?.("feishu-voice skip agent_end flush: missing run/session target");
      return;
    }

    const pending = pendingRunVoiceByKey.get(effectiveRunKey);
    if (pending && event?.success === false) {
      if (pending.timer) clearTimerImpl(pending.timer);
      clearPendingRunAliases(effectiveRunKey, pending);
      pendingRunVoiceByKey.delete(effectiveRunKey);
      api.logger?.info?.(`feishu-voice cleared pending reply after unsuccessful agent_end (run=${effectiveRunKey})`);
      return;
    }

    if (pending) {
      pending.agentEnded = true;
      pendingRunVoiceByKey.set(effectiveRunKey, pending);
    }
    void flushRunVoiceReply(effectiveRunKey, "agent_end");
  });

  api.on("session_end", (_event, ctx) => {
    const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
    if (!sessionKey) return;

    for (const [runKey, pending] of pendingRunVoiceByKey.entries()) {
      if (pending?.sessionKey === sessionKey || Array.isArray(pending?.aliases) && pending.aliases.includes(`session:${sessionKey}`)) {
        if (pending?.timer) clearTimerImpl(pending.timer);
        clearPendingRunAliases(runKey, pending);
        pendingRunVoiceByKey.delete(runKey);
      }
    }
    pendingRunAliasToKey.delete(`session:${sessionKey}`);
    sessionTargetBySessionKey.delete(sessionKey);
  });

  api.on("message_sent", (event, ctx) => {
    if (!isFeishuChannelContext(ctx)) return;
    if (!event?.success) return;
    rememberSessionTarget(ctx, event);
    const target = normalizeFeishuTarget(event?.to || ctx?.conversationId || "");
    touchConversationRecords(ctx, [target, event?.to], (record) => {
      record.lastOutboundAt = Date.now();
    });
  });
}

module.exports = {
  registerVoiceReplyHooks
};
