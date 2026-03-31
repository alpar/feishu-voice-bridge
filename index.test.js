"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const plugin = require("./index.js");

const {
  extractAssistantTextFromAgentMessage,
  extractMessageSentText,
  mergeVoiceReplyCandidate,
  prepareVoiceReplyText,
  registerVoiceReplyHooks
} = plugin.__private;

function createApi() {
  const handlers = new Map();
  return {
    handlers,
    logger: {
      info() {},
      warn() {},
      error() {}
    },
    on(name, handler) {
      handlers.set(name, handler);
    }
  };
}

function emit(api, name, event, ctx) {
  const handler = api.handlers.get(name);
  if (!handler) throw new Error(`missing handler: ${name}`);
  return handler(event, ctx);
}

function createTimerHarness() {
  const timers = [];
  return {
    timers,
    setTimer(fn, ms) {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true;
    }
  };
}

function createConfig(overrides = {}) {
  return {
    gatewayConfig: {},
    maxReplyChars: 280,
    maxCapturedReplyChars: 6000,
    promptToolTtsForText: false,
    voiceReplySummaryEnabled: true,
    voiceReplySummaryMaxSentences: 3,
    voiceReplySummaryJoiner: "；",
    voiceReplySummaryPrefix: "语音摘要：",
    voiceReplySummarySuffix: "（完整内容请查看文字回复）",
    voiceReplyCooldownMs: 1,
    voiceReplyDebounceMs: 0,
    voiceReplyEnabled: true,
    voiceReplyMode: "always",
    voiceReplyWindowMs: 60_000,
    ...overrides
  };
}

function createCtx(overrides = {}) {
  return {
    accountId: "default",
    channelId: "feishu",
    conversationId: "user:ou_test_user",
    sessionKey: "agent:test:feishu:direct:ou_test_user",
    ...overrides
  };
}

function createInboundEvent(overrides = {}) {
  return {
    chatId: "ou_test_user",
    messageId: "om_test_inbound",
    ...overrides
  };
}

test("extractMessageSentText 能读取嵌套的出站文本负载", () => {
  assert.equal(extractMessageSentText({ details: { content: "最终文本" } }), "最终文本");
  assert.equal(extractMessageSentText({ payload: { text: "消息正文" } }), "消息正文");
  assert.equal(extractMessageSentText({}), "");
});

test("extractAssistantTextFromAgentMessage 能提取最终 assistant 文本块", () => {
  assert.equal(extractAssistantTextFromAgentMessage({
    role: "assistant",
    content: [
      { type: "text", text: "最终回复" },
      { type: "toolCall", name: "tts", arguments: { text: "语音文案" } }
    ]
  }), "最终回复");
  assert.equal(extractAssistantTextFromAgentMessage({
    role: "assistant",
    content: [{ type: "text", text: "NO_REPLY" }]
  }), "NO_REPLY");
  assert.equal(extractAssistantTextFromAgentMessage({
    role: "user",
    content: [{ type: "text", text: "用户消息" }]
  }), "");
});

test("mergeVoiceReplyCandidate 优先采用 message_sent 文本并丢弃不匹配的 tts 音频", () => {
  const merged = mergeVoiceReplyCandidate(
    {
      text: "收到，我先查一下。",
      audio: { source: "tts-audio" },
      source: "tts"
    },
    {
      text: "收到，我先查一下插件并给你文字和语音两路回复。",
      source: "message_sent"
    }
  );

  assert.equal(merged.text, "收到，我先查一下插件并给你文字和语音两路回复。");
  assert.equal(merged.source, "message_sent");
  assert.equal(merged.audio, null);
});

test("prepareVoiceReplyText 对短回复保持原文，不生成摘要", () => {
  const result = prepareVoiceReplyText("简短回复", createConfig({
    maxReplyChars: 12
  }));
  assert.equal(result.summaryApplied, false);
  assert.equal(result.text, "简短回复");
});

test("prepareVoiceReplyText 会跳过文本中的 emoji 表情", () => {
  const result = prepareVoiceReplyText("老板好 😀 今天进度正常 ❤️ 我们继续加油 👨‍👩‍👧‍👦", createConfig({
    maxReplyChars: 80
  }));
  assert.equal(result.summaryApplied, false);
  assert.equal(result.text, "老板好 今天进度正常 我们继续加油");
});

test("prepareVoiceReplyText 会为长回复生成带前缀的摘要文本", () => {
  const config = createConfig({
    maxReplyChars: 30,
    voiceReplySummaryJoiner: " / ",
    voiceReplySummaryPrefix: "Summary: ",
    voiceReplySummarySuffix: "",
    voiceReplySummaryMaxSentences: 2
  });
  const longText = "这是第一句内容，包含更多详细描述以超过长度限制。第二句继续展开细节，确保文本很长。第三句补充说明。";
  const result = prepareVoiceReplyText(longText, config);
  assert.equal(result.summaryApplied, true);
  assert.ok(result.text.startsWith("Summary: "));
  assert.ok(result.text.length <= 30);
});

test("单独的 message_sent 事件不再直接驱动自动语音回复", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig(), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  const inboundCtx = createCtx();
  emit(api, "inbound_claim", createInboundEvent(), inboundCtx);
  emit(api, "message_sent", {
    success: true,
    text: "这是最终文本回复",
    to: "user:ou_test_user"
  }, inboundCtx);

  assert.equal(timers.timers.length, 0);
  assert.equal(sends.length, 0);
});

test("语音桥接会忽略 message_sent 中的转写回显", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    gatewayConfig: {
      tools: {
        media: {
          audio: {
            echoFormat: "📝 {transcript}",
            echoTranscript: true
          }
        }
      }
    }
  }), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  const inboundCtx = createCtx();
  emit(api, "inbound_claim", createInboundEvent(), inboundCtx);
  emit(api, "message_sent", {
    success: true,
    text: "📝 双回复测试",
    to: "user:ou_test_user"
  }, inboundCtx);

  assert.equal(timers.timers.length, 0);
  assert.equal(sends.length, 0);
});

test("长 assistant 回复会在发送语音前先转成摘要", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    maxReplyChars: 40,
    voiceReplySummaryPrefix: "Summary: ",
    voiceReplySummarySuffix: "",
    voiceReplySummaryJoiner: " / ",
    voiceReplySummaryMaxSentences: 2
  }), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  const inboundCtx = createCtx();
  emit(api, "inbound_claim", createInboundEvent(), inboundCtx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{
        type: "text",
        text: "第一句介绍一下背景，并且包含大量细节文字，使得这一段非常长，明显超过语音上限。第二句继续给出详细结论，并且同样很长很长，仍然在扩写细节。第三句提供额外说明，也写得很长。"
      }]
    }
  }, {
    accountId: "default",
    sessionKey: inboundCtx.sessionKey
  });

  emit(api, "agent_end", {}, { sessionKey: inboundCtx.sessionKey });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sends.length, 1);
  assert.ok(sends[0].text.startsWith("Summary:"));
  assert.ok(sends[0].text.length <= 50);
});

test.skip("即使 message_sent 和 assistant 的标识不同，也会合并到同一个待发送回复", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig(), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  const baseCtx = createCtx();
  emit(api, "inbound_claim", createInboundEvent(), baseCtx);

  emit(api, "message_sent", {
    success: true,
    text: "这是最终文本回复",
    to: "user:ou_test_user"
  }, baseCtx);

  const finalCtx = createCtx({ runId: "run-123" });
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "这是最终文本回复" }]
    }
  }, finalCtx);

  assert.equal(timers.timers.length, 2);
  assert.equal(timers.timers[0].cleared, true);
  emit(api, "agent_end", {}, { runId: "run-123", sessionKey: "agent:test:feishu:direct:ou_test_user" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "这是最终文本回复");
  assert.equal(sends[0].replyToMessageId, "om_test_inbound");
});

test.skip("后续上下文稀疏时，assistant 最终文本仍可复用最近一次入站元数据", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig(), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  emit(api, "inbound_claim", createInboundEvent(), createCtx());

  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "这是来自稀疏上下文的语音回复" }]
    }
  }, {
    accountId: "default",
    runId: "run-sparse",
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  });

  emit(api, "agent_end", {}, {
    runId: "run-sparse",
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, "ou_test_user");
  assert.equal(sends[0].replyToMessageId, "om_test_inbound");
});

test("assistant_message 回退路径可以复用记忆中的最近入站元数据", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound"
  }), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  emit(api, "inbound_claim", createInboundEvent(), createCtx());
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "收到您的语音消息。继续使用语音模式进行回复。" }]
    }
  }, {
    accountId: "default",
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  });

  assert.equal(timers.timers.length, 0);
  emit(api, "agent_end", {}, { sessionKey: "agent:test:feishu:direct:ou_test_user" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "收到您的语音消息。继续使用语音模式进行回复。");
  assert.equal(sends[0].replyToMessageId, "om_test_inbound");
});

test("当 runId 没命中待发送键时，agent_end 会回退到 session 级待发送项", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound"
  }), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  emit(api, "inbound_claim", createInboundEvent(), createCtx());
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "最终语音回复文本" }]
    }
  }, {
    accountId: "default",
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  });

  emit(api, "agent_end", { success: true }, {
    runId: "run-without-pending-alias",
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "最终语音回复文本");
});

test.skip("多次 assistant 写入时，最后一条最终文本仍保持最高优先级", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound"
  }), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  const ctx = {
    accountId: "default",
    runId: "run-session-fallback",
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  };
  emit(api, "inbound_claim", createInboundEvent(), createCtx());
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "中间说明文本" }]
    }
  }, ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "最终文本版本" }]
    }
  }, ctx);
  assert.equal(timers.timers.length, 2);
  emit(api, "agent_end", {}, { runId: "run-session-fallback", sessionKey: "agent:test:feishu:direct:ou_test_user" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "最终文本版本");
});

test.skip("即使最终文本像进度提示，只要 agent_end 成功仍会发送语音", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound"
  }), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  const ctx = {
    accountId: "default",
    runId: "run-progress-final",
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  };

  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "收到您的测试语音。继续使用语音模式进行回复。" }]
    }
  }, ctx);
  assert.equal(timers.timers.length, 1);
  emit(api, "agent_end", {}, { runId: "run-progress-final", sessionKey: "agent:test:feishu:direct:ou_test_user" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "收到您的测试语音。继续使用语音模式进行回复。");
});

test.skip("只有进度文本时，超时发送会延后到真正最终回复到达", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound"
  }), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  emit(api, "inbound_claim", createInboundEvent(), createCtx());
  const ctx = createCtx({ runId: "run-progress" });
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "好的，我来帮您查询，请稍等。" }]
    }
  }, ctx);

  assert.equal(timers.timers.length, 1);
  await timers.timers[0].fn();
  assert.equal(sends.length, 0);
  assert.equal(timers.timers.length, 2);

  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "老板，查到结果了，这是最终回复。" }]
    }
  }, ctx);

  emit(api, "agent_end", {}, { runId: "run-progress", sessionKey: "agent:test:feishu:direct:ou_test_user" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "老板，查到结果了，这是最终回复。");
});

test("assistant_message 可以通过 target 别名合并到已有待发送回复", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound"
  }), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  emit(api, "inbound_claim", createInboundEvent(), createCtx());
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "好的，我来查一下。" }]
    }
  }, {
    accountId: "default",
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  });

  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "老板，查到最终结果了。" }]
    }
  }, {
    accountId: "default",
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  });

  assert.equal(timers.timers.length, 0);
  emit(api, "agent_end", {}, { sessionKey: "agent:test:feishu:direct:ou_test_user" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "老板，查到最终结果了。");
});

test("单独的 tts 工具调用不再直接驱动自动语音回复", async () => {
  const api = createApi();
  registerVoiceReplyHooks(api, createConfig());
  assert.equal(api.handlers.has("after_tool_call"), false);
});

test("失败的 agent_end 会清理待发送回复且不会发出语音", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound"
  }), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  emit(api, "inbound_claim", createInboundEvent(), createCtx());
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "这段回复在 stop 后不该发语音。" }]
    }
  }, {
    accountId: "default",
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  });

  emit(api, "agent_end", { success: false }, { sessionKey: "agent:test:feishu:direct:ou_test_user" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sends.length, 0);
});
