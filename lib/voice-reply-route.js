"use strict";

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
const { markExternalEventProcessed, pruneStaleVoiceReplyState } = require("./voice-reply-store");

function createVoiceReplyRouter(params) {
  const { api, config, store } = params;
  const stateTtlMs = Math.max(
    Number(config?.voiceReplyWindowMs || 0) * 3,
    60 * 60 * 1000
  );

  function pruneStore() {
    pruneStaleVoiceReplyState(store, Date.now(), stateTtlMs);
  }

  function getConversationKeys(ctx, targets) {
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
  }

  function touchConversationRecords(ctx, targets, mutate) {
    pruneStore();
    const keys = getConversationKeys(ctx, targets);
    for (const key of keys) {
      const record = store.stateByConversation.get(key) || {};
      mutate(record);
      record.updatedAt = Date.now();
      store.stateByConversation.set(key, record);
    }
    return keys;
  }

  function mergeConversationKeys(...groups) {
    const merged = new Set();
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      for (const key of group) {
        if (typeof key === "string" && key.trim()) merged.add(key.trim());
      }
    }
    return Array.from(merged);
  }

  function readConversationRecord(keys) {
    const merged = {};
    for (const key of Array.isArray(keys) ? keys : []) {
      const record = store.stateByConversation.get(key);
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
  }

  function updateConversationRecords(keys, mutate) {
    pruneStore();
    for (const key of Array.isArray(keys) ? keys : []) {
      const record = store.stateByConversation.get(key) || {};
      mutate(record);
      record.updatedAt = Date.now();
      store.stateByConversation.set(key, record);
    }
  }

  function getLatestInboundKey(accountId, target) {
    const normalizedTarget = normalizeFeishuTarget(target);
    if (!normalizedTarget) return "";
    return `${normalizeAccountId(accountId)}:${normalizedTarget}`;
  }

  function rememberLatestInbound(accountId, target, patch) {
    pruneStore();
    const key = getLatestInboundKey(accountId, target);
    if (!key) return;
    const existing = store.latestInboundByTarget.get(key) || {};
    store.latestInboundByTarget.set(key, {
      ...existing,
      ...patch,
      updatedAt: Date.now()
    });
  }

  function readLatestInbound(accountId, target) {
    const key = getLatestInboundKey(accountId, target);
    return key ? (store.latestInboundByTarget.get(key) || null) : null;
  }

  function buildInboundEventKey(event, ctx) {
    const accountId = typeof ctx?.accountId === "string" && ctx.accountId.trim() ? ctx.accountId.trim() : "default";
    const messageId = normalizeFeishuMessageId(resolveFeishuMessageIdFromEventOrContext(event, ctx));
    const target = normalizeFeishuTarget(resolveFeishuTargetFromEventOrContext(event, ctx));
    if (!messageId && !target) return "";
    return [
      accountId,
      messageId || "no-message",
      target || "no-target"
    ].join(":");
  }

  function rememberSessionTarget(ctx, event) {
    pruneStore();
    if (!isFeishuChannelContext(ctx)) return;
    const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";

    const target = resolveFeishuTargetFromEventOrContext(event, ctx);
    const replyToMessageId = resolveFeishuMessageIdFromEventOrContext(event, ctx);
    if (!target) return;

    const accountId = typeof ctx?.accountId === "string" && ctx.accountId.trim() ? ctx.accountId.trim() : "default";
    const runId = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";

    const conversationKeys = getConversationKeys(ctx, [
      target,
      event?.chatId,
      event?.metadata?.to,
      inferTargetFromSessionKey(sessionKey)
    ]);
    const existing = sessionKey ? store.sessionTargetBySessionKey.get(sessionKey) : null;
    const routeRecord = {
      target,
      accountId,
      replyToMessageId: replyToMessageId || existing?.replyToMessageId || "",
      inboundMessageId: replyToMessageId || existing?.inboundMessageId || "",
      conversationKeys: mergeConversationKeys(existing?.conversationKeys, conversationKeys),
      updatedAt: Date.now()
    };

    if (sessionKey) {
      store.sessionTargetBySessionKey.set(sessionKey, routeRecord);
    }

    if (runId) {
      store.routeByRunId.set(runId, routeRecord);
    }
    store.latestRouteByAccount.set(accountId, routeRecord);
    rememberLatestInbound(
      accountId,
      target,
      {
        replyToMessageId: replyToMessageId || existing?.replyToMessageId || ""
      }
    );
  }

  function markInboundVoice(event, ctx) {
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
  }

  function handleInboundLifecycleEvent(event, ctx) {
    rememberSessionTarget(ctx, event);
    markInboundVoice(event, ctx);

    const eventKey = buildInboundEventKey(event, ctx);
    if (eventKey && !markExternalEventProcessed(store, eventKey, Math.max(config.voiceReplyWindowMs, 60_000))) {
      return;
    }
  }

  function resolveSessionTarget(ctx) {
    pruneStore();
    const currentTarget = resolveFeishuTargetFromEventOrContext(null, ctx);
    const currentReplyToMessageId = resolveFeishuMessageIdFromEventOrContext(null, ctx);
    const runId = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : "";
    if (currentTarget) {
      const remembered = typeof ctx?.sessionKey === "string" ? store.sessionTargetBySessionKey.get(ctx.sessionKey) : null;
      const accountId = typeof ctx?.accountId === "string" && ctx.accountId.trim() ? ctx.accountId.trim() : "default";
      const latestInbound = readLatestInbound(accountId, currentTarget);
      if (runId) {
        store.routeByRunId.set(runId, {
          target: currentTarget,
          accountId,
          replyToMessageId: currentReplyToMessageId || remembered?.replyToMessageId || latestInbound?.replyToMessageId || "",
          inboundMessageId: currentReplyToMessageId || remembered?.inboundMessageId || latestInbound?.replyToMessageId || "",
          conversationKeys: mergeConversationKeys(
            remembered?.conversationKeys,
            getConversationKeys(ctx, [currentTarget, remembered?.target, inferTargetFromSessionKey(ctx?.sessionKey)])
          ),
          updatedAt: Date.now()
        });
      }
      return {
        target: currentTarget,
        accountId,
        replyToMessageId: currentReplyToMessageId || remembered?.replyToMessageId || latestInbound?.replyToMessageId || "",
        inboundMessageId: currentReplyToMessageId || remembered?.inboundMessageId || latestInbound?.replyToMessageId || "",
        lastInboundAt: Number(latestInbound?.lastInboundAt || 0),
        lastVoiceInboundAt: Number(latestInbound?.lastVoiceInboundAt || 0),
        resolutionSource: "current_target",
        conversationKeys: mergeConversationKeys(
          remembered?.conversationKeys,
          getConversationKeys(ctx, [currentTarget, remembered?.target, inferTargetFromSessionKey(ctx?.sessionKey)])
        )
      };
    }

    const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
    if (!sessionKey) {
      const rememberedByRun = runId ? store.routeByRunId.get(runId) : null;
      const accountId = typeof ctx?.accountId === "string" && ctx.accountId.trim() ? ctx.accountId.trim() : rememberedByRun?.accountId || "default";
      const rememberedFallback = rememberedByRun?.target
        ? rememberedByRun
        : store.latestRouteByAccount.get(accountId);
      if (!rememberedFallback?.target) return null;
      const latestInbound = readLatestInbound(accountId, rememberedFallback.target);
      return {
        ...rememberedFallback,
        accountId,
        replyToMessageId: currentReplyToMessageId || rememberedFallback.replyToMessageId || latestInbound?.replyToMessageId || "",
        inboundMessageId: currentReplyToMessageId || rememberedFallback.inboundMessageId || latestInbound?.replyToMessageId || "",
        lastInboundAt: Number(latestInbound?.lastInboundAt || 0),
        lastVoiceInboundAt: Number(latestInbound?.lastVoiceInboundAt || 0),
        resolutionSource: rememberedByRun?.target ? "run_memory" : "latest_route",
        conversationKeys: mergeConversationKeys(
          rememberedFallback.conversationKeys,
          getConversationKeys(ctx, [rememberedFallback.target])
        )
      };
    }
    const remembered = store.sessionTargetBySessionKey.get(sessionKey);
    if (remembered?.target) {
      const accountId = typeof ctx?.accountId === "string" && ctx.accountId.trim() ? ctx.accountId.trim() : remembered.accountId || "default";
      const latestInbound = readLatestInbound(accountId, remembered.target);
      if (runId) {
        store.routeByRunId.set(runId, {
          ...remembered,
          accountId,
          replyToMessageId: remembered.replyToMessageId || latestInbound?.replyToMessageId || "",
          inboundMessageId: remembered.inboundMessageId || latestInbound?.replyToMessageId || "",
          updatedAt: Date.now()
        });
      }
      return {
        ...remembered,
        accountId,
        replyToMessageId: remembered.replyToMessageId || latestInbound?.replyToMessageId || "",
        inboundMessageId: remembered.inboundMessageId || latestInbound?.replyToMessageId || "",
        lastInboundAt: Number(latestInbound?.lastInboundAt || 0),
        lastVoiceInboundAt: Number(latestInbound?.lastVoiceInboundAt || 0),
        resolutionSource: "session_memory"
      };
    }

    const inferred = inferTargetFromSessionKey(sessionKey);
    if (inferred) {
      const accountId = typeof ctx?.accountId === "string" && ctx.accountId.trim() ? ctx.accountId.trim() : "default";
      const latestInbound = readLatestInbound(accountId, inferred);
      const resolved = {
        target: inferred,
        accountId,
        replyToMessageId: currentReplyToMessageId || latestInbound?.replyToMessageId || "",
        inboundMessageId: currentReplyToMessageId || latestInbound?.replyToMessageId || "",
        lastInboundAt: Number(latestInbound?.lastInboundAt || 0),
        lastVoiceInboundAt: Number(latestInbound?.lastVoiceInboundAt || 0),
        resolutionSource: "session_inferred",
        conversationKeys: getConversationKeys(ctx, [inferred])
      };
      if (runId) {
        store.routeByRunId.set(runId, {
          target: resolved.target,
          accountId: resolved.accountId,
          replyToMessageId: resolved.replyToMessageId,
          inboundMessageId: resolved.inboundMessageId,
          conversationKeys: resolved.conversationKeys,
          updatedAt: Date.now()
        });
      }
      return resolved;
    }
    return null;
  }

  function clearSession(sessionKey) {
    store.pendingRunAliasToKey.delete(`session:${sessionKey}`);
    store.sessionTargetBySessionKey.delete(sessionKey);
  }

  return {
    clearSession,
    getConversationKeys,
    handleInboundLifecycleEvent,
    mergeConversationKeys,
    readConversationRecord,
    rememberSessionTarget,
    resolveSessionTarget,
    touchConversationRecords,
    updateConversationRecords
  };
}

module.exports = {
  createVoiceReplyRouter
};
