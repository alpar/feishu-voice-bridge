"use strict";

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

function registerVoiceReplyHooks(api, config, deps = {}) {
  if (typeof api?.on !== "function") return;

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

  // 所有候选回复先入队，等 agent_end 再决定最终播哪一条。
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
