"use strict";

function createVoiceReplyExecutor(params = {}) {
  const logger = params.logger || null;
  const setTimer = typeof params.setTimer === "function" ? params.setTimer : setTimeout;
  const dispatchAsync = typeof params.dispatchAsync === "function"
    ? params.dispatchAsync
    : (fn) => Promise.resolve().then(fn).catch((err) => {
      const detail = err && typeof err.message === "string" ? err.message : String(err);
      logger?.warn?.(`feishu-voice async dispatch failed: ${detail}`);
    });

  const queue = [];
  let queueRunning = false;
  let nextJobId = 1;

  async function drainQueue() {
    try {
      while (queue.length > 0) {
        const nextJob = queue.shift();
        if (!nextJob) continue;

        try {
          const waitMs = Math.max(0, Date.now() - Number(nextJob.enqueuedAt || 0));
          logger?.info?.(
            `feishu-voice queue started (job=${nextJob.id}, run=${nextJob.runKey}, attempt=${nextJob.attempt}/${nextJob.maxAttempts}, depth=${queue.length}, queuedMs=${waitMs})`
          );
          await nextJob.execute();
          logger?.info?.(
            `feishu-voice queue finished (job=${nextJob.id}, run=${nextJob.runKey}, attempt=${nextJob.attempt}/${nextJob.maxAttempts}, depth=${queue.length})`
          );
        } catch (err) {
          const detail = err && typeof err.message === "string" ? err.message : String(err);
          logger?.warn?.(
            `feishu-voice background send failed (job=${nextJob.id}, run=${nextJob.runKey}, attempt=${nextJob.attempt}/${nextJob.maxAttempts}): ${detail}`
          );
        }
      }
    } finally {
      queueRunning = false;
    }
  }

  function scheduleDrain() {
    if (queueRunning) return;
    queueRunning = true;
    try {
      dispatchAsync(drainQueue);
    } catch (err) {
      queueRunning = false;
      const detail = err && typeof err.message === "string" ? err.message : String(err);
      logger?.warn?.(`feishu-voice async dispatch failed: ${detail}`);
    }
  }

  function enqueueJob(job) {
    const queuedJob = {
      enqueuedAt: Date.now(),
      id: nextJobId++,
      ...job
    };
    queue.push(queuedJob);
    logger?.info?.(
      `feishu-voice queue enqueued (job=${queuedJob.id}, run=${queuedJob.runKey}, attempt=${queuedJob.attempt}/${queuedJob.maxAttempts}, depth=${queue.length})`
    );
    // 语音发送必须串行，避免多轮自动回复在飞书网关里并发上传、互相打乱顺序。
    scheduleDrain();
  }

  function enqueueRetryable(job) {
    const maxAttempts = Math.max(1, Number(job?.maxAttempts) || 1);
    const retryBackoffMs = Math.max(0, Number(job?.retryBackoffMs) || 0);

    const enqueueAttempt = (attempt) => enqueueJob({
      runKey: job?.runKey || "unknown",
      attempt,
      maxAttempts,
      execute: async () => {
        try {
          await job.executeAttempt(attempt, maxAttempts);
        } catch (err) {
          if (attempt < maxAttempts) {
            const retryDelayMs = retryBackoffMs * attempt;
            const detail = err && typeof err.message === "string" ? err.message : String(err);
            logger?.warn?.(
              `feishu-voice auto reply attempt failed; scheduling retry (run=${job?.runKey || "unknown"}, target=${job?.target || "unknown"}, attempt=${attempt}/${maxAttempts}, retryInMs=${retryDelayMs}): ${detail}`
            );
            setTimer(() => {
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

  return {
    enqueueJob,
    enqueueRetryable
  };
}

module.exports = {
  createVoiceReplyExecutor
};
