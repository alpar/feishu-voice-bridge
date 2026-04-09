"use strict";

const {
  clearPendingRunAliases,
  pruneExpiryMap,
  rememberPendingRunAliases,
  resolveCanonicalRunKey
} = require("./voice-reply-store");

function createVoiceTurnRepository(store) {
  function getTrimmedString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : "";
  }

  function getRunId(ctx) {
    return getTrimmedString(ctx?.runId);
  }

  function getSessionKey(ctx) {
    return getTrimmedString(ctx?.sessionKey);
  }

  function resolveRunKey(runKeyOrAlias) {
    return resolveCanonicalRunKey(store, runKeyOrAlias);
  }

  function findRunKeyByAlias(alias) {
    return store.pendingRunAliasToKey.get(alias) || "";
  }

  function rememberRunAliases(runKey, aliases) {
    rememberPendingRunAliases(store, runKey, aliases);
  }

  function getPending(runKey) {
    return store.pendingRunVoiceByKey.get(runKey) || null;
  }

  function setPending(runKey, pending) {
    store.pendingRunVoiceByKey.set(runKey, pending);
    return pending;
  }

  function hasPending(runKey) {
    return store.pendingRunVoiceByKey.has(runKey);
  }

  function deletePending(runKey, pending) {
    const current = pending || getPending(runKey);
    if (current) {
      clearPendingRunAliases(store, runKey, current);
    }
    store.pendingRunVoiceByKey.delete(runKey);
    return current;
  }

  function iteratePendingEntries() {
    return store.pendingRunVoiceByKey.entries();
  }

  function markRecentAgentEnd(ctx, ttlMs) {
    const now = Date.now();
    const expiresAt = now + Math.max(1, Number(ttlMs) || 0);
    const runId = getRunId(ctx);
    const sessionKey = getSessionKey(ctx);
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
    const runId = getRunId(ctx);
    const sessionKey = getSessionKey(ctx);
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
    const runId = getRunId(ctx);
    if (runId && Number(store.agentEndExpiryByRunKey.get(runId) || 0) > now) {
      return true;
    }
    const sessionKey = getSessionKey(ctx);
    return !!(sessionKey && Number(store.agentEndExpiryBySessionKey.get(sessionKey) || 0) > now);
  }

  function hasCompletedTurn(turnKey) {
    if (!turnKey) return false;
    const now = Date.now();
    pruneExpiryMap(store.completedVoiceTurnExpiryByKey, now);
    return Number(store.completedVoiceTurnExpiryByKey.get(turnKey) || 0) > now;
  }

  function markCompletedTurn(turnKey, ttlMs) {
    if (!turnKey) return;
    pruneExpiryMap(store.completedVoiceTurnExpiryByKey, Date.now());
    store.completedVoiceTurnExpiryByKey.set(
      turnKey,
      Date.now() + Math.max(1, Number(ttlMs) || 0)
    );
  }

  function setTextSendingAt(sessionKey, timestamp = Date.now()) {
    const normalizedSessionKey = getTrimmedString(sessionKey);
    if (!normalizedSessionKey) return;
    store.textSendingBySessionKey.set(normalizedSessionKey, timestamp);
  }

  function getTextSendingAt(sessionKey) {
    const normalizedSessionKey = getTrimmedString(sessionKey);
    if (!normalizedSessionKey) return 0;
    return Number(store.textSendingBySessionKey.get(normalizedSessionKey) || 0);
  }

  function setTextSentAt(sessionKey, timestamp = Date.now()) {
    const normalizedSessionKey = getTrimmedString(sessionKey);
    if (!normalizedSessionKey) return;
    store.textSentBySessionKey.set(normalizedSessionKey, timestamp);
  }

  function getTextSentAt(sessionKey) {
    const normalizedSessionKey = getTrimmedString(sessionKey);
    if (!normalizedSessionKey) return 0;
    return Number(store.textSentBySessionKey.get(normalizedSessionKey) || 0);
  }

  function setActiveRunId(sessionKey, runId, timestamp = Date.now()) {
    const normalizedSessionKey = getTrimmedString(sessionKey);
    const normalizedRunId = getTrimmedString(runId);
    if (!normalizedSessionKey || !normalizedRunId) return;
    store.activeRunIdBySessionKey.set(normalizedSessionKey, {
      runId: normalizedRunId,
      updatedAt: timestamp
    });
  }

  function getActiveRunId(sessionKey) {
    const normalizedSessionKey = getTrimmedString(sessionKey);
    if (!normalizedSessionKey) return "";
    const record = store.activeRunIdBySessionKey.get(normalizedSessionKey);
    return typeof record?.runId === "string" ? record.runId : "";
  }

  function markTranscriptEchoSkipped(sessionKey, text = "", timestamp = Date.now()) {
    const normalizedSessionKey = getTrimmedString(sessionKey);
    if (!normalizedSessionKey) return;
    store.transcriptEchoSkippedBySessionKey.set(normalizedSessionKey, timestamp);
    if (typeof text === "string" && text.trim()) {
      store.transcriptEchoTextBySessionKey.set(normalizedSessionKey, text);
    }
  }

  function wasTranscriptEchoSkipped(sessionKey) {
    const normalizedSessionKey = getTrimmedString(sessionKey);
    if (!normalizedSessionKey) return false;
    return store.transcriptEchoSkippedBySessionKey.has(normalizedSessionKey);
  }

  function getTranscriptEchoText(sessionKey) {
    const normalizedSessionKey = getTrimmedString(sessionKey);
    if (!normalizedSessionKey) return "";
    return typeof store.transcriptEchoTextBySessionKey.get(normalizedSessionKey) === "string"
      ? store.transcriptEchoTextBySessionKey.get(normalizedSessionKey)
      : "";
  }

  function clearSessionSignals(sessionKey) {
    const normalizedSessionKey = getTrimmedString(sessionKey);
    if (!normalizedSessionKey) return;
    store.activeRunIdBySessionKey.delete(normalizedSessionKey);
    store.textSendingBySessionKey.delete(normalizedSessionKey);
    store.textSentBySessionKey.delete(normalizedSessionKey);
    store.transcriptEchoSkippedBySessionKey.delete(normalizedSessionKey);
    store.transcriptEchoTextBySessionKey.delete(normalizedSessionKey);
  }

  return {
    clearRecentAgentEnd,
    clearSessionSignals,
    deletePending,
    findRunKeyByAlias,
    getPending,
    getActiveRunId,
    getTextSendingAt,
    getTextSentAt,
    getTranscriptEchoText,
    hasCompletedTurn,
    hasPending,
    iteratePendingEntries,
    markCompletedTurn,
    markRecentAgentEnd,
    markTranscriptEchoSkipped,
    rememberRunAliases,
    resolveRunKey,
    setPending,
    setActiveRunId,
    setTextSendingAt,
    setTextSentAt,
    wasAgentEndedRecently,
    wasTranscriptEchoSkipped
  };
}

module.exports = {
  createVoiceTurnRepository
};
