"use strict";

const EXTERNAL_EVENT_TTL_MS = 10 * 60 * 1000;
const EXTERNAL_EVENT_MAX_ENTRIES = 2000;
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

module.exports = {
  clearPendingRunAliases,
  createVoiceReplyStore,
  getSharedVoiceReplyStore,
  pruneExpiryMap,
  markExternalEventProcessed,
  rememberPendingRunAliases,
  resetSharedVoiceReplyStore,
  resolveCanonicalRunKey
};
