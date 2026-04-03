"use strict";

const HOOKS_REGISTERED_SYMBOL = Symbol.for("openclaw.feishuVoiceBridge.voiceReplyHooksRegistered");

const {
  FEISHU_FINAL_VOICE_ONLY_PROMPT,
  FEISHU_TEXT_TTS_PROMPT
} = require("./constants");
const {
  isFeishuChannelContext,
  normalizeFeishuTarget
} = require("./feishu");
const {
  extractAssistantTextFromAgentMessage,
  shouldSkipVoiceReplyText
} = require("./text");
const { getSharedVoiceReplyStore } = require("./voice-reply-store");
const { createVoiceReplyRouter } = require("./voice-reply-route");
const { createVoiceReplyDispatcher } = require("./voice-reply-dispatcher");

function extractBeforeAgentReplyText(event) {
  const directTextCandidates = [
    event?.cleanedBody,
    event?.text,
    event?.replyText,
    event?.finalText,
    typeof event?.content === "string" ? event.content : ""
  ];

  for (const candidate of directTextCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const messageLikeCandidates = [
    event?.reply,
    event?.message,
    event?.agentReply
  ];

  for (const candidate of messageLikeCandidates) {
    const text = extractAssistantTextFromAgentMessage(candidate);
    if (text) return text;
  }

  return "";
}

function summarizeBeforeAgentReplyShape(event) {
  if (!event || typeof event !== "object") return "non-object";
  const topLevel = Object.entries(event)
    .map(([key, value]) => `${key}:${Array.isArray(value) ? "array" : typeof value}`)
    .sort();

  const nestedCandidates = ["reply", "message", "agentReply"]
    .map((key) => {
      const value = event[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) return "";
      const nestedShape = Object.entries(value)
        .map(([nestedKey, nestedValue]) => `${nestedKey}:${Array.isArray(nestedValue) ? "array" : typeof nestedValue}`)
        .sort()
        .join("|");
      return nestedShape ? `${key}{${nestedShape}}` : "";
    })
    .filter(Boolean);

  return [...topLevel, ...nestedCandidates].join(",");
}

function registerVoiceReplyHooks(api, config, deps = {}) {
  if (typeof api?.on !== "function") return;
  if (api[HOOKS_REGISTERED_SYMBOL]) return;
  if (typeof api === "object" || typeof api === "function") {
    api[HOOKS_REGISTERED_SYMBOL] = true;
  }

  const store = deps.store || getSharedVoiceReplyStore();
  const router = createVoiceReplyRouter({ api, config, store });
  const dispatcher = createVoiceReplyDispatcher({ api, config, router, store, deps });

  api.on("before_prompt_build", (_event, ctx) => {
    if (!config.voiceReplyEnabled || config.voiceReplyMode === "off") return;
    if (!isFeishuChannelContext(ctx)) return;
    if (!config.promptToolTtsForText) {
      return {
        appendSystemContext: FEISHU_FINAL_VOICE_ONLY_PROMPT
      };
    }
    return {
      appendSystemContext: `${FEISHU_FINAL_VOICE_ONLY_PROMPT}\n\n${FEISHU_TEXT_TTS_PROMPT}`
    };
  });

  api.on("inbound_claim", (event, ctx) => {
    dispatcher.clearPendingForSession(ctx, "new_inbound");
    router.handleInboundLifecycleEvent(event, ctx);
  });

  api.on("message_received", (event, ctx) => {
    router.handleInboundLifecycleEvent(event, ctx);
  });

  api.on("before_dispatch", (event, ctx) => {
    router.handleInboundLifecycleEvent(event, ctx);
  });

  // 新版 OpenClaw 可在最终回复落盘前直接给插件最终文本。
  api.on("before_agent_reply", (event, ctx) => {
    const text = extractBeforeAgentReplyText(event);
    if (!text) {
      api.logger?.info?.(
        `feishu-voice before_agent_reply ignored: empty text (run=${ctx?.runId || "none"}, session=${ctx?.sessionKey || "none"}, shape=${summarizeBeforeAgentReplyShape(event)})`
      );
      return;
    }
    api.logger?.info?.(
      `feishu-voice before_agent_reply captured text (run=${ctx?.runId || "none"}, session=${ctx?.sessionKey || "none"}, chars=${text.length})`
    );
    dispatcher.enqueueVoiceReply({ text }, {
      accountId: typeof ctx?.accountId === "string" ? ctx.accountId : undefined,
      sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined,
      runId: typeof ctx?.runId === "string" ? ctx.runId : undefined
    }, "before_agent_reply");
  });

  // 先缓存候选文本，等 agent_end 再决定最终播报内容。
  api.on("before_message_write", (event, ctx) => {
    const text = extractAssistantTextFromAgentMessage(event?.message);
    if (!text) return;
    dispatcher.enqueueVoiceReply({ text }, {
      accountId: typeof ctx?.accountId === "string" ? ctx.accountId : undefined,
      sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined,
      runId: typeof ctx?.runId === "string" ? ctx.runId : undefined
    }, "assistant_message");
  });

  api.on("after_tool_call", (event, ctx) => {
    dispatcher.handleAfterToolCall(event, ctx);
  });

  api.on("message_sending", (event, ctx) => {
    if (!isFeishuChannelContext(ctx)) return;
    router.rememberSessionTarget(ctx, event);
    const text = typeof event?.content === "string" ? event.content : "";
    if (text && shouldSkipVoiceReplyText(text)) return;
    dispatcher.markTextSending({
      accountId: typeof ctx?.accountId === "string" ? ctx.accountId : undefined,
      runId: typeof ctx?.runId === "string" ? ctx.runId : undefined,
      sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined,
      chatId: event?.to || ctx?.conversationId || ""
    }, text);
  });

  api.on("agent_end", (event, ctx) => {
    dispatcher.handleAgentEnd(event, ctx);
  });

  api.on("session_end", (_event, ctx) => {
    dispatcher.handleSessionEnd(ctx);
  });

  api.on("message_sent", (event, ctx) => {
    if (!isFeishuChannelContext(ctx)) return;
    if (!event?.success) return;
    router.rememberSessionTarget(ctx, event);
    dispatcher.handleMessageSent(event, {
      accountId: typeof ctx?.accountId === "string" ? ctx.accountId : undefined,
      runId: typeof ctx?.runId === "string" ? ctx.runId : undefined,
      sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined,
      chatId: event?.to || ctx?.conversationId || ""
    });
    const target = normalizeFeishuTarget(event?.to || ctx?.conversationId || "");
    router.touchConversationRecords(ctx, [target, event?.to], (record) => {
      record.lastOutboundAt = Date.now();
    });
  });
}

module.exports = {
  registerVoiceReplyHooks
};
