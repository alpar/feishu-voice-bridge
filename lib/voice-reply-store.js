"use strict";

const EXTERNAL_EVENT_TTL_MS = 10 * 60 * 1000;
const EXTERNAL_EVENT_MAX_ENTRIES = 2000;
const VOICE_REPLY_STATE_TTL_MS = 60 * 60 * 1000;
const SHARED_STORE_SYMBOL = Symbol.for("openclaw.feishuVoiceReplyStore");

function createVoiceReplyStore() {
  return {
    stateByConversation: new Map(),
    latestInboundByTarget: new Map(),
    latestRouteByAccount: new Map(),
    routeByRunId: new Map(),
    sessionTargetBySessionKey: new Map(),
    agentEndExpiryByRunKey: new Map(),
    agentEndExpiryBySessionKey: new Map(),
    textSendingBySessionKey: new Map(),
    textSentBySessionKey: new Map(),
    transcriptEchoSkippedBySessionKey: new Map(),
    transcriptEchoTextBySessionKey: new Map(),
    pendingRunVoiceByKey: new Map(),
    pendingRunAliasToKey: new Map(),
    externalEventExpiryByKey: new Map(),
    completedVoiceTurnExpiryByKey: new Map()
  };
}

function getSharedVoiceReplyStore() {
  if (!globalThis[SHARED_STORE_SYMBOL]) {
    globalThis[SHARED_STORE_SYMBOL] = createVoiceReplyStore();
  }
  return globalThis[SHARED_STORE_SYMBOL];
}

function resetSharedVoiceReplyStore() {
  globalThis[SHARED_STORE_SYMBOL] = createVoiceReplyStore();
  return globalThis[SHARED_STORE_SYMBOL];
}

function pruneExpiryMap(map, now) {
  for (const [key, expiresAt] of map.entries()) {
    if (expiresAt <= now) {
      map.delete(key);
    }
  }

  while (map.size > EXTERNAL_EVENT_MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (!oldest) break;
    map.delete(oldest);
  }
}

function markExternalEventProcessed(store, eventKey, ttlMs = EXTERNAL_EVENT_TTL_MS) {
  if (!eventKey) return false;
  const now = Date.now();
  pruneExpiryMap(store.externalEventExpiryByKey, now);

  const existing = store.externalEventExpiryByKey.get(eventKey);
  if (existing && existing > now) {
    return false;
  }

  store.externalEventExpiryByKey.set(eventKey, now + ttlMs);
  return true;
}

function rememberPendingRunAliases(store, runKey, aliases) {
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    if (typeof alias === "string" && alias.trim()) {
      store.pendingRunAliasToKey.set(alias, runKey);
    }
  }
}

function resolveCanonicalRunKey(store, runKeyOrAlias) {
  if (typeof runKeyOrAlias !== "string" || !runKeyOrAlias.trim()) return "";
  const normalizedKey = runKeyOrAlias.trim();
  return store.pendingRunAliasToKey.get(normalizedKey)
    || store.pendingRunAliasToKey.get(`run:${normalizedKey}`)
    || store.pendingRunAliasToKey.get(`session:${normalizedKey}`)
    || normalizedKey;
}

function clearPendingRunAliases(store, runKey, pending) {
  for (const alias of Array.isArray(pending?.aliases) ? pending.aliases : []) {
    if (store.pendingRunAliasToKey.get(alias) === runKey) {
      store.pendingRunAliasToKey.delete(alias);
    }
  }
}

function getRecordUpdatedAt(record) {
  if (!record || typeof record !== "object") return 0;
  return Math.max(
    Number(record.updatedAt || 0),
    Number(record.lastInboundAt || 0),
    Number(record.lastVoiceInboundAt || 0),
    Number(record.lastOutboundAt || 0),
    Number(record.lastVoiceReplyAt || 0),
    Number(record.lastTextSendingAt || 0),
    Number(record.lastAssistantMessageAt || 0)
  );
}

function pruneStateMap(map, now, ttlMs) {
  for (const [key, record] of map.entries()) {
    const updatedAt = getRecordUpdatedAt(record);
    if (updatedAt > 0 && now - updatedAt > ttlMs) {
      map.delete(key);
    }
  }
}

function pruneTimestampMap(map, now, ttlMs) {
  const removedKeys = [];
  for (const [key, updatedAt] of map.entries()) {
    if (Number(updatedAt || 0) > 0 && now - Number(updatedAt || 0) > ttlMs) {
      map.delete(key);
      removedKeys.push(key);
    }
  }
  return removedKeys;
}

function pruneStaleVoiceReplyState(store, now = Date.now(), ttlMs = VOICE_REPLY_STATE_TTL_MS) {
  const effectiveTtlMs = Math.max(1, Number(ttlMs) || VOICE_REPLY_STATE_TTL_MS);

  pruneStateMap(store.stateByConversation, now, effectiveTtlMs);
  pruneStateMap(store.latestInboundByTarget, now, effectiveTtlMs);
  pruneStateMap(store.latestRouteByAccount, now, effectiveTtlMs);
  pruneStateMap(store.routeByRunId, now, effectiveTtlMs);
  pruneStateMap(store.sessionTargetBySessionKey, now, effectiveTtlMs);

  pruneTimestampMap(store.agentEndExpiryByRunKey, now, effectiveTtlMs);
  pruneTimestampMap(store.agentEndExpiryBySessionKey, now, effectiveTtlMs);
  pruneTimestampMap(store.textSendingBySessionKey, now, effectiveTtlMs);
  pruneTimestampMap(store.textSentBySessionKey, now, effectiveTtlMs);
  const removedTranscriptSessions = pruneTimestampMap(store.transcriptEchoSkippedBySessionKey, now, effectiveTtlMs);
  for (const sessionKey of removedTranscriptSessions) {
    store.transcriptEchoTextBySessionKey.delete(sessionKey);
  }
}

module.exports = {
  clearPendingRunAliases,
  createVoiceReplyStore,
  getSharedVoiceReplyStore,
  pruneExpiryMap,
  pruneStaleVoiceReplyState,
  markExternalEventProcessed,
  rememberPendingRunAliases,
  resetSharedVoiceReplyStore,
  resolveCanonicalRunKey,
  VOICE_REPLY_STATE_TTL_MS
};
