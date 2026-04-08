"use strict";

const EXTERNAL_EVENT_TTL_MS = 10 * 60 * 1000;
const EXTERNAL_EVENT_MAX_ENTRIES = 2000;
const VOICE_REPLY_STATE_TTL_MS = 60 * 60 * 1000;
// 长跑网关里这些 Map 可能积累多个会话/多轮 run；
// 除 TTL 外再加一层容量上限，避免活跃窗口内的状态无限膨胀。
const VOICE_REPLY_STATE_LIMITS = Object.freeze({
  stateByConversation: 2000,
  latestInboundByTarget: 2000,
  latestRouteByAccount: 64,
  routeByRunId: 2000,
  sessionTargetBySessionKey: 2000,
  agentEndExpiryByRunKey: 2000,
  agentEndExpiryBySessionKey: 2000,
  textSendingBySessionKey: 2000,
  textSentBySessionKey: 2000,
  transcriptEchoSkippedBySessionKey: 2000,
  pendingRunVoiceByKey: 2000
});
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

function pruneOldestEntries(map, maxEntries, getUpdatedAt, onDelete) {
  const effectiveMaxEntries = Math.max(0, Number(maxEntries) || 0);
  if (!effectiveMaxEntries || map.size <= effectiveMaxEntries) return [];

  const overflowCount = map.size - effectiveMaxEntries;
  // Map 本身是插入序，但这里按“最近活跃时间”裁剪，
  // 避免旧对象长时间留在表里，即使它后插入过。
  const candidates = Array.from(map.entries())
    .map(([key, value]) => ({
      key,
      value,
      updatedAt: Math.max(0, Number(getUpdatedAt(value, key) || 0))
    }))
    .sort((left, right) => left.updatedAt - right.updatedAt);

  const removedKeys = [];
  for (const entry of candidates.slice(0, overflowCount)) {
    map.delete(entry.key);
    removedKeys.push(entry.key);
    if (typeof onDelete === "function") {
      onDelete(entry.value, entry.key, "capacity");
    }
  }
  return removedKeys;
}

function pruneStateMap(map, now, ttlMs, maxEntries) {
  for (const [key, record] of map.entries()) {
    const updatedAt = getRecordUpdatedAt(record);
    if (updatedAt > 0 && now - updatedAt > ttlMs) {
      map.delete(key);
    }
  }
  pruneOldestEntries(map, maxEntries, getRecordUpdatedAt);
}

function pruneTimestampMap(map, now, ttlMs, maxEntries) {
  const removedKeys = [];
  for (const [key, updatedAt] of map.entries()) {
    if (Number(updatedAt || 0) > 0 && now - Number(updatedAt || 0) > ttlMs) {
      map.delete(key);
      removedKeys.push(key);
    }
  }
  removedKeys.push(...pruneOldestEntries(map, maxEntries, (updatedAt) => Number(updatedAt || 0)));
  return removedKeys;
}

function prunePendingVoiceReplyState(store, now = Date.now(), ttlMs = VOICE_REPLY_STATE_TTL_MS, options = {}) {
  const effectiveTtlMs = Math.max(1, Number(ttlMs) || VOICE_REPLY_STATE_TTL_MS);
  const maxEntries = Math.max(0, Number(options.maxEntries) || VOICE_REPLY_STATE_LIMITS.pendingRunVoiceByKey);
  const removedRunKeys = [];
  const onDelete = typeof options.onDelete === "function" ? options.onDelete : null;

  // pending 除了正文候选，还挂着 alias/timer；这里统一做清理，
  // 避免 stale run 在长跑进程里留下不可见但会误命中的状态。
  for (const [runKey, pending] of store.pendingRunVoiceByKey.entries()) {
    const updatedAt = getRecordUpdatedAt(pending);
    if (updatedAt > 0 && now - updatedAt > effectiveTtlMs) {
      store.pendingRunVoiceByKey.delete(runKey);
      clearPendingRunAliases(store, runKey, pending);
      removedRunKeys.push(runKey);
      onDelete?.(pending, runKey, "ttl");
    }
  }

  const overflowRemoved = pruneOldestEntries(
    store.pendingRunVoiceByKey,
    maxEntries,
    getRecordUpdatedAt,
    (pending, runKey) => {
      clearPendingRunAliases(store, runKey, pending);
      onDelete?.(pending, runKey, "capacity");
    }
  );
  removedRunKeys.push(...overflowRemoved);
  return removedRunKeys;
}

function pruneStaleVoiceReplyState(store, now = Date.now(), ttlMs = VOICE_REPLY_STATE_TTL_MS) {
  const effectiveTtlMs = Math.max(1, Number(ttlMs) || VOICE_REPLY_STATE_TTL_MS);

  pruneStateMap(store.stateByConversation, now, effectiveTtlMs, VOICE_REPLY_STATE_LIMITS.stateByConversation);
  pruneStateMap(store.latestInboundByTarget, now, effectiveTtlMs, VOICE_REPLY_STATE_LIMITS.latestInboundByTarget);
  pruneStateMap(store.latestRouteByAccount, now, effectiveTtlMs, VOICE_REPLY_STATE_LIMITS.latestRouteByAccount);
  pruneStateMap(store.routeByRunId, now, effectiveTtlMs, VOICE_REPLY_STATE_LIMITS.routeByRunId);
  pruneStateMap(store.sessionTargetBySessionKey, now, effectiveTtlMs, VOICE_REPLY_STATE_LIMITS.sessionTargetBySessionKey);

  pruneTimestampMap(store.agentEndExpiryByRunKey, now, effectiveTtlMs, VOICE_REPLY_STATE_LIMITS.agentEndExpiryByRunKey);
  pruneTimestampMap(store.agentEndExpiryBySessionKey, now, effectiveTtlMs, VOICE_REPLY_STATE_LIMITS.agentEndExpiryBySessionKey);
  pruneTimestampMap(store.textSendingBySessionKey, now, effectiveTtlMs, VOICE_REPLY_STATE_LIMITS.textSendingBySessionKey);
  pruneTimestampMap(store.textSentBySessionKey, now, effectiveTtlMs, VOICE_REPLY_STATE_LIMITS.textSentBySessionKey);
  const removedTranscriptSessions = pruneTimestampMap(
    store.transcriptEchoSkippedBySessionKey,
    now,
    effectiveTtlMs,
    VOICE_REPLY_STATE_LIMITS.transcriptEchoSkippedBySessionKey
  );
  for (const sessionKey of removedTranscriptSessions) {
    store.transcriptEchoTextBySessionKey.delete(sessionKey);
  }
}

module.exports = {
  clearPendingRunAliases,
  createVoiceReplyStore,
  getSharedVoiceReplyStore,
  pruneExpiryMap,
  prunePendingVoiceReplyState,
  pruneStaleVoiceReplyState,
  markExternalEventProcessed,
  rememberPendingRunAliases,
  resetSharedVoiceReplyStore,
  resolveCanonicalRunKey,
  VOICE_REPLY_STATE_LIMITS,
  VOICE_REPLY_STATE_TTL_MS
};
