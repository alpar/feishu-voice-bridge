"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const plugin = require("./index.js");
const packageJson = require("./package.json");
const { resolveSpeechOptions } = require("./lib/config");
const { buildMediaUnderstandingProvider, buildProvider } = require("./lib/providers");
const { createPluginRuntime } = require("./lib/runtime");

const {
  extractAssistantTextFromAgentMessage,
  extractMessageSentText,
  isFeishuChannelContext,
  loadGeneratedAudioArtifact,
  isVoiceInboundEvent,
  mergeVoiceReplyCandidate,
  prepareVoiceReplyText,
  resolvePluginConfig,
  resetSharedVoiceReplyStore,
  synthesizeVoiceAudio,
  shouldSkipVoiceReplyText,
  registerVoiceReplyHooks
} = plugin.__private;

function createApi(loggerOverrides = {}) {
  resetSharedVoiceReplyStore();
  const handlers = new Map();
  return {
    handlers,
    logger: {
      info() {},
      warn() {},
      error() {},
      ...loggerOverrides
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
    voiceReplyNoTextFallbackMs: 0,
    voiceReplyAssistantSettleMs: 0,
    voiceReplyRetryCount: 2,
    voiceReplyRetryBackoffMs: 5000,
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
    role: "assistant",
    content: [
      { type: "text", text: "需要您先确认这次操作。" },
      { type: "toolCall", name: "search", arguments: { q: "杭州天气" } },
      { type: "text", text: "最终回答第一段。" },
      { type: "text", text: "最终回答第二段。" }
    ]
  }), "最终回答第一段。\n最终回答第二段。");
  assert.equal(extractAssistantTextFromAgentMessage({
    role: "user",
    content: [{ type: "text", text: "用户消息" }]
  }), "");
});

test("isVoiceInboundEvent 能识别飞书 file_key 语音消息体", () => {
  assert.equal(isVoiceInboundEvent({
    body: "{\"file_key\":\"file_v3_0010c_demo\",\"duration\":4000}"
  }), true);
});

test("isFeishuChannelContext 能从 sessionKey 和目标字段识别飞书上下文", () => {
  assert.equal(isFeishuChannelContext({
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  }), true);
  assert.equal(isFeishuChannelContext({
    conversationId: "user:ou_test_user"
  }), true);
});

test("默认会注入禁止常规 tts tool 的飞书异步语音提示", () => {
  const api = createApi();
  registerVoiceReplyHooks(api, createConfig({
    voiceReplyEnabled: true,
    promptToolTtsForText: false
  }));
  const result = emit(api, "before_prompt_build", {}, createCtx());
  assert.equal(typeof result?.appendSystemContext, "string");
  assert.match(result.appendSystemContext, /do not call the `tts` tool/i);
  assert.match(result.appendSystemContext, /one matching voice reply asynchronously/i);
});

test("语音入站时会在 before_tool_call 阶段拦截 tts 工具", () => {
  const api = createApi();
  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "always",
    voiceReplyDebounceMs: 0
  }));

  const ctx = createCtx({
    runId: "run-block-tts"
  });
  emit(api, "message_received", createInboundEvent({
    body: "{\"file_key\":\"file_v3_0010c_demo\",\"duration\":4000}"
  }), ctx);

  const result = emit(api, "before_tool_call", {
    toolName: "tts",
    params: { text: "不该触发的语音工具" }
  }, ctx);

  assert.equal(result?.block, true);
  assert.match(String(result?.blockReason || ""), /tts tool/i);
});

test("默认关闭 before_agent_reply 实验链路", async () => {
  const sends = [];
  const api = createApi();
  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "always",
    voiceReplyDebounceMs: 0
  }), {
    sendVoiceReplyImpl: async (config, logger, params) => {
      sends.push(params.text);
      return true;
    }
  });

  emit(api, "message_received", createInboundEvent(), createCtx());
  emit(api, "before_agent_reply", {
    cleanedBody: "这条文本默认不应被使用"
  }, createCtx({
    runId: "run-before-agent-reply-disabled"
  }));
  await emit(api, "agent_end", {
    success: true
  }, createCtx({
    runId: "run-before-agent-reply-disabled"
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sends, []);
});

test("before_agent_reply 会提前缓存最终回复文本", async () => {
  const sends = [];
  const api = createApi();
  registerVoiceReplyHooks(api, createConfig({
    enableBeforeAgentReply: true,
    voiceReplyMode: "always",
    voiceReplyDebounceMs: 0
  }), {
    sendVoiceReplyImpl: async (config, logger, params) => {
      sends.push(params.text);
      return true;
    }
  });

  emit(api, "message_received", createInboundEvent(), createCtx());

  emit(api, "before_agent_reply", {
    reply: {
      role: "assistant",
      content: [{ type: "text", text: "这是最终回复" }]
    }
  }, createCtx({
    runId: "run-before-agent-reply"
  }));

  await emit(api, "agent_end", {
    success: true
  }, createCtx({
    runId: "run-before-agent-reply"
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sends, ["这是最终回复"]);
});

test("before_agent_reply 会兼容 OpenClaw 2026.4.2 的 cleanedBody", async () => {
  const sends = [];
  const api = createApi();
  registerVoiceReplyHooks(api, createConfig({
    enableBeforeAgentReply: true,
    voiceReplyMode: "always",
    voiceReplyDebounceMs: 0
  }), {
    sendVoiceReplyImpl: async (config, logger, params) => {
      sends.push(params.text);
      return true;
    }
  });

  emit(api, "message_received", createInboundEvent(), createCtx());

  emit(api, "before_agent_reply", {
    cleanedBody: "这是 cleanedBody 最终回复"
  }, createCtx({
    runId: "run-before-agent-reply-cleaned-body"
  }));

  await emit(api, "agent_end", {
    success: true
  }, createCtx({
    runId: "run-before-agent-reply-cleaned-body"
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sends, ["这是 cleanedBody 最终回复"]);
});

test("before_agent_reply 命中最终文本后不再走 text hooks missing 兜底日志", async () => {
  const sends = [];
  const infos = [];
  const api = createApi({
    info(message) {
      infos.push(String(message));
    }
  });
  registerVoiceReplyHooks(api, createConfig({
    enableBeforeAgentReply: true,
    voiceReplyMode: "always",
    voiceReplyDebounceMs: 0
  }), {
    sendVoiceReplyImpl: async (config, logger, params) => {
      sends.push(params.text);
      return true;
    }
  });

  emit(api, "message_received", createInboundEvent(), createCtx());

  emit(api, "before_agent_reply", {
    cleanedBody: "<message role=\"assistant\"><final_answer>最终正文</final_answer></message>"
  }, createCtx({
    runId: "run-before-agent-reply-final"
  }));

  await emit(api, "agent_end", {
    success: true
  }, createCtx({
    runId: "run-before-agent-reply-final"
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sends, ["最终正文"]);
  assert.equal(infos.some((message) => message.includes("text hooks missing; using assistant fallback")), false);
});

test("before_agent_reply 若处于 transcript echo 会话中会被忽略，等待后续真正 assistant 文本", async () => {
  const sends = [];
  const api = createApi();
  registerVoiceReplyHooks(api, createConfig({
    enableBeforeAgentReply: true,
    voiceReplyMode: "always",
    voiceReplyDebounceMs: 0,
    gatewayConfig: {
      tools: {
        media: {
          audio: {
            echoTranscript: true,
            echoFormat: "📝 {transcript}"
          }
        }
      }
    }
  }), {
    sendVoiceReplyImpl: async (config, logger, params) => {
      sends.push(params.text);
      return true;
    }
  });

  const ctx = createCtx({
    runId: "run-before-agent-reply-transcript"
  });

  emit(api, "message_received", createInboundEvent({
    body: "{\"file_key\":\"file_v3_0010c_demo\",\"duration\":4000}"
  }), ctx);

  emit(api, "message_sending", {
    content: "📝 帮我查一下今天杭州天气"
  }, ctx);

  emit(api, "before_agent_reply", {
    cleanedBody: "帮我查一下今天杭州天气"
  }, ctx);

  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "杭州今天多云，最高 25 度。" }]
    }
  }, ctx);

  await emit(api, "agent_end", {
    success: true
  }, ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sends, ["杭州今天多云，最高 25 度。"]);
});

test("语音入站时会跳过 before_agent_reply，等待后续 assistant 最终文本", async () => {
  const sends = [];
  const infos = [];
  const api = createApi({
    info(message) {
      infos.push(String(message));
    }
  });
  registerVoiceReplyHooks(api, createConfig({
    enableBeforeAgentReply: true,
    voiceReplyMode: "always",
    voiceReplyDebounceMs: 0
  }), {
    sendVoiceReplyImpl: async (config, logger, params) => {
      sends.push(params.text);
      return true;
    }
  });

  const ctx = createCtx({
    runId: "run-before-agent-reply-voice-inbound"
  });

  emit(api, "message_received", createInboundEvent({
    body: "{\"file_key\":\"file_v3_0010c_demo\",\"duration\":4000}"
  }), ctx);

  emit(api, "before_agent_reply", {
    cleanedBody: "这是一段不应该被提前朗读的中间文本"
  }, ctx);

  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "真正的最终回答" }]
    }
  }, ctx);

  await emit(api, "agent_end", {
    success: true
  }, ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sends, ["真正的最终回答"]);
  assert.equal(infos.some((message) => message.includes("skip before_agent_reply capture: voice inbound session")), true);
});

test("语音入站的 no_text_fallback 会等待 assistant 收敛后再发送", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "always",
    voiceReplyDebounceMs: 0,
    voiceReplyNoTextFallbackMs: 0,
    voiceReplyAssistantSettleMs: 8000
  }), {
    clearTimer: timers.clearTimer,
    setTimer: timers.setTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  const ctx = createCtx({
    runId: "run-assistant-settle"
  });

  emit(api, "message_received", createInboundEvent({
    body: "{\"file_key\":\"file_v3_0010c_demo\",\"duration\":4000}"
  }), ctx);

  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "第一段中间内容" }]
    }
  }, ctx);
  emit(api, "agent_end", { success: true }, ctx);

  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].ms, 8000);
  assert.deepEqual(sends, []);

  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "真正的最终回答" }]
    }
  }, ctx);

  assert.equal(timers.timers.length, 2);
  assert.equal(timers.timers[0].cleared, true);
  assert.equal(timers.timers[1].ms, 8000);
  assert.deepEqual(sends, []);
});

test("重复 register 不会重复注册 provider 和 hooks", () => {
  resetSharedVoiceReplyStore();
  const handlers = new Map();
  let speechProviderCount = 0;
  let mediaProviderCount = 0;
  let onCount = 0;
  const api = {
    pluginConfig: {},
    config: {},
    runtime: {},
    logger: {
      info() {},
      warn() {},
      error() {}
    },
    on(name, handler) {
      onCount += 1;
      const list = handlers.get(name) || [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerSpeechProvider() {
      speechProviderCount += 1;
    },
    registerMediaUnderstandingProvider() {
      mediaProviderCount += 1;
    }
  };

  plugin.register(api);
  plugin.register(api);

  assert.equal(speechProviderCount, 1);
  assert.equal(mediaProviderCount, 1);
  assert.equal(onCount, 12);
  assert.deepEqual(
    Array.from(handlers.values(), (items) => items.length),
    new Array(12).fill(1)
  );
});

test("shouldSkipVoiceReplyText 会过滤 /stop 自动回复和 NO_REPLY", () => {
  assert.equal(shouldSkipVoiceReplyText("NO_REPLY"), true);
  assert.equal(shouldSkipVoiceReplyText("⚙️ Agent was aborted."), true);
  assert.equal(shouldSkipVoiceReplyText("这是正常回复"), false);
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

test("mergeVoiceReplyCandidate 对同源 authoritative 文本更新采用后到内容", () => {
  const merged = mergeVoiceReplyCandidate(
    {
      text: "我先查一下资料来源。",
      source: "assistant_message"
    },
    {
      text: "老板，最终结果已经查到了。",
      source: "assistant_message"
    }
  );

  assert.equal(merged.text, "老板，最终结果已经查到了。");
  assert.equal(merged.source, "assistant_message");
});

test("prepareVoiceReplyText 对短回复保持原文，不生成摘要", async () => {
  const result = await prepareVoiceReplyText("简短回复", createConfig({
    maxReplyChars: 12
  }));
  assert.equal(result.summaryApplied, false);
  assert.equal(result.text, "简短回复");
});

test("prepareVoiceReplyText 会跳过文本中的 emoji 表情", async () => {
  const result = await prepareVoiceReplyText("老板好 😀 今天进度正常 ❤️ 我们继续加油 👨‍👩‍👧‍👦", createConfig({
    maxReplyChars: 80
  }));
  assert.equal(result.summaryApplied, false);
  assert.equal(result.text, "老板好 今天进度正常 我们继续加油");
});

test("prepareVoiceReplyText 会去掉结构标签和转写块，只保留最终回答正文", async () => {
  const result = await prepareVoiceReplyText(
    "<message role=\"user\">语音转写：帮我查天气</message><message role=\"assistant\"><final_answer>周末多云，最高 24 度。</final_answer></message>",
    createConfig({
      maxReplyChars: 80
    })
  );
  assert.equal(result.summaryApplied, false);
  assert.equal(result.text, "周末多云，最高 24 度。");
});

test("prepareVoiceReplyText 会为长回复生成带前缀的摘要文本", async () => {
  const config = createConfig({
    maxReplyChars: 30,
    voiceReplySummaryJoiner: " / ",
    voiceReplySummaryPrefix: "Summary: ",
    voiceReplySummarySuffix: "",
    voiceReplySummaryMaxSentences: 2
  });
  const longText = "这是第一句内容，包含更多详细描述以超过长度限制。第二句继续展开细节，确保文本很长。第三句补充说明。";
  const result = await prepareVoiceReplyText(longText, config);
  assert.equal(result.summaryApplied, true);
  assert.ok(result.text.startsWith("Summary: "));
  assert.ok(result.text.length <= 30);
});

test("prepareVoiceReplyText 优先使用 OpenClaw 风格的模型摘要", async () => {
  const result = await prepareVoiceReplyText(
    "第一段非常长，详细解释背景。第二段继续展开技术细节。第三段补充结论和建议。",
    createConfig({
      maxReplyChars: 24,
      voiceReplySummaryPrefix: "语音摘要：",
      voiceReplySummarySuffix: "（完整内容请查看文字回复）"
    }),
    {
      summarizeWithModel: async () => "这是更自然的模型摘要。"
    }
  );

  assert.equal(result.summaryApplied, true);
  assert.equal(result.summaryStrategy, "openclaw-model");
  assert.equal(result.text, "这是更自然的模型摘要。");
});

test("loadGeneratedAudioArtifact 会保留原生音频格式信息", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-audio-"));
  const filePath = path.join(tmpRoot, "reply.wav");
  const wavBuffer = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x2c, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
    0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  ]);

  fs.writeFileSync(filePath, wavBuffer);

  try {
    const artifact = loadGeneratedAudioArtifact(filePath, "test");
    assert.equal(artifact.fileType, "wav");
    assert.equal(artifact.fileName, "reply.wav");
    assert.equal(artifact.mimeType, "audio/wav");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("loadGeneratedAudioArtifact 会按真实 codec 修正 ogg 的 fileType", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-opus-"));
  const filePath = path.join(tmpRoot, "reply.ogg");

  try {
    const pcmPath = path.join(tmpRoot, "reply.wav");
    require("node:child_process").execFileSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:duration=1",
      pcmPath
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000
    });

    require("node:child_process").execFileSync("ffmpeg", [
      "-y",
      "-i",
      pcmPath,
      "-c:a",
      "libopus",
      filePath
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000
    });

    const artifact = loadGeneratedAudioArtifact(filePath, "test");
    assert.equal(artifact.fileType, "opus");
    assert.equal(artifact.fileName, "voice.opus");
    assert.equal(artifact.mimeType, "audio/ogg");
    assert.ok(artifact.durationMs >= 900);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveSpeechOptions 优先读取原生 providerConfig/providerOverrides", () => {
  const options = resolveSpeechOptions({
    rawPluginConfig: {
      defaultVoice: "plugin-default",
      defaultRate: "+20",
      defaultPitch: "0"
    },
    gatewayConfig: {
      messages: {
        tts: {
          providers: {
            microsoft: {
              voice: "zh-CN-XiaoyiNeural",
              rate: "+10%",
              pitch: "+2Hz"
            }
          }
        }
      }
    },
    defaultVoice: "fallback-voice",
    defaultRate: "+20",
    defaultPitch: "0"
  }, {
    providerConfig: {
      voice: "zh-CN-YunjianNeural",
      rate: "+15%",
      pitch: "+1Hz"
    },
    providerOverrides: {
      voice: "zh-CN-YunxiNeural"
    }
  });

  assert.equal(options.voice, "zh-CN-YunxiNeural");
  assert.equal(options.rate, "+15");
  assert.equal(options.pitch, "+1");
});

test("resolvePluginConfig 不再暴露旧脚本路径配置", () => {
  const cfg = resolvePluginConfig({
    pluginConfig: {
      scriptPath: "/tmp/evil.sh",
      sttScriptPath: "/tmp/evil-stt.sh",
      defaultVoice: "zh-CN-YunxiNeural"
    }
  });

  assert.equal("scriptPath" in cfg, false);
  assert.equal("sttScriptPath" in cfg, false);
  assert.deepEqual(cfg.securityWarnings, []);
  assert.equal(cfg.defaultVoice, "zh-CN-YunxiNeural");
});

test("synthesizeVoiceAudio 缺少本地工具链时不会泄露内部细节", () => {
  assert.throws(() => synthesizeVoiceAudio({
    runtime: {
      hasToolTts: false
    }
  }, {
    warn() {}
  }, {
    text: "测试",
    voice: "zh-CN-XiaoxiaoNeural",
    rate: "+20",
    pitch: "0"
  }), /feishu-voice synthesize unavailable: local toolchain not ready/);
});

test("buildProvider 会把解析后的语音参数传给原生 TTS", async () => {
  let captured = null;
  const provider = buildProvider({
    rawPluginConfig: {
      defaultVoice: "plugin-default",
      defaultRate: "+20",
      defaultPitch: "0"
    },
    gatewayConfig: {
      messages: {
        tts: {
          providers: {
            microsoft: {
              voice: "gateway-voice",
              rate: "+10%",
              pitch: "+2Hz"
            }
          }
        }
    }
    },
    maxReplyChars: 200,
    defaultVoice: "fallback-voice",
    defaultRate: "+20",
    defaultPitch: "0"
  }, {
    info() {},
    warn() {},
    error() {}
  }, {
    hasNativeTts: true,
    hasToolTts: false
  }, {
    synthesizeVoiceAudioWithNativeTtsImpl: async (_config, _logger, params) => {
      captured = params;
      return {
        audioBuffer: Buffer.from([1]),
        fileType: "opus",
        fileName: "reply.opus"
      };
    }
  });

  await provider.synthesize({
    text: "这是原生 TTS 请求",
    providerConfig: {
      voice: "request-config",
      rate: "+3%",
      pitch: "+1Hz"
    },
    providerOverrides: {
      voice: "request-override",
      rate: "+5%",
      pitch: "+4Hz"
    }
  });

  assert.equal(captured.voice, "request-override");
  assert.equal(captured.rate, "+5");
  assert.equal(captured.pitch, "+4");
});

test("package.json 发布清单包含插件运行所需目录", () => {
  assert.ok(Array.isArray(packageJson.files));
  assert.ok(packageJson.files.includes("lib"));
  assert.ok(packageJson.files.includes("scripts"));
});

test("createPluginRuntime 会识别原生 STT 与原生摘要能力", () => {
  const runtime = createPluginRuntime({
    gatewayConfig: {}
  }, {
    stt: {
      transcribeAudioFile: async () => ({ text: "ok" })
    }
  });

  assert.equal(runtime.hasNativeStt, true);
  assert.equal(typeof runtime.summary.stt, "string");
  assert.equal(runtime.summary.stt, "native:media-understanding");
});

test("createPluginRuntime 会给缺失外部依赖生成告警", () => {
  const runtime = createPluginRuntime({
    gatewayConfig: {}
  }, null, {
    commandExists(command) {
      return command === "ffprobe";
    }
  });

  assert.equal(runtime.hasToolTts, false);
  assert.equal(runtime.hasToolStt, false);
  assert.equal(runtime.hasFfmpeg, false);
  assert.equal(runtime.hasEdgeTts, false);
  assert.equal(runtime.hasWhisper, false);
  assert.deepEqual(runtime.dependencyWarnings, [
    "local TTS toolchain requires `edge-tts`",
    "local TTS toolchain requires `ffmpeg`",
    "local STT toolchain requires `whisper`",
    "local STT toolchain requires `ffmpeg`"
  ]);
});

test("buildMediaUnderstandingProvider 优先使用 OpenClaw 原生 STT runtime", async () => {
  const provider = buildMediaUnderstandingProvider({
    gatewayConfig: {},
    sttLanguage: "zh-CN",
    sttModel: "small"
  }, {
    info() {},
    warn() {},
    error() {}
  }, {
    hasNativeStt: true,
    hasToolStt: false,
    coreRuntime: {
      stt: {
        transcribeAudioFile: async ({ filePath, cfg, mime }) => {
          assert.equal(typeof filePath, "string");
          assert.equal(typeof cfg, "object");
          assert.equal(mime, "audio/ogg");
          return {
            text: " 这是原生转写结果 "
          };
        }
      }
    }
  });

  const result = await provider.transcribeAudio({
    buffer: Buffer.from([1, 2, 3, 4]),
    fileName: "voice.ogg"
  });

  assert.equal(result.text, "这是原生转写结果");
  assert.equal(result.model, "openclaw:media-understanding");
});

test("buildMediaUnderstandingProvider 原生不可用时会回退到本地工具链", async () => {
  const provider = buildMediaUnderstandingProvider({
    gatewayConfig: {},
    sttLanguage: "zh-CN",
    sttModel: "small"
  }, {
    info() {},
    warn() {},
    error() {}
  }, {
    hasNativeStt: false,
    hasToolStt: true
  }, {
    transcribeAudioFileWithToolchainImpl: ({ inputPath, language, model }) => {
      assert.equal(typeof inputPath, "string");
      assert.equal(language, "zh-CN");
      assert.equal(model, "small");
      return {
        text: " 这是工具链转写结果 ",
        model: "local-whisper:small"
      };
    }
  });

  const result = await provider.transcribeAudio({
    buffer: Buffer.from([1, 2, 3]),
    mimeType: "audio/ogg",
    fileName: "input.ogg"
  });

  assert.equal(result.text, "这是工具链转写结果");
  assert.equal(result.model, "local-whisper:small");
});

test("buildMediaUnderstandingProvider 缺少本地工具链时返回脱敏错误", async () => {
  const provider = buildMediaUnderstandingProvider({
    gatewayConfig: {},
    sttLanguage: "zh-CN",
    sttModel: "small"
  }, {
    info() {},
    warn() {},
    error() {}
  }, {
    hasNativeStt: false,
    hasToolStt: false
  });

  await assert.rejects(() => provider.transcribeAudio({
    buffer: Buffer.from([1, 2, 3]),
    mimeType: "audio/ogg",
    fileName: "input.ogg"
  }), /feishu-voice transcribe unavailable: local toolchain not ready/);
});

test("after_tool_call 捕获官方 tts 音频后，最终发送仍优先采用该文本，但不直接复用音频上传飞书", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-tts-tool-"));
  const filePath = path.join(tmpRoot, "reply.wav");
  const wavBuffer = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x2c, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
    0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  ]);

  fs.writeFileSync(filePath, wavBuffer);

  try {
    registerVoiceReplyHooks(api, createConfig({
      voiceReplyMode: "inbound",
      voiceReplySummaryEnabled: false
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
    emit(api, "after_tool_call", {
      toolName: "tts",
      params: {
        text: "这是最终文本回复"
      },
      result: {
        audioPath: filePath
      }
    }, {
      accountId: "default",
      runId: "run-tts",
      sessionKey: inboundCtx.sessionKey
    });
    emit(api, "before_message_write", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "这是最终文本回复" }]
      }
    }, {
      accountId: "default",
      runId: "run-tts",
      sessionKey: inboundCtx.sessionKey
    });

    // 先文字后语音：只有在 message_sent 之后才会触发语音回传。
    emit(api, "message_sent", {
      success: true,
      text: "这是最终文本回复",
      to: "user:ou_test_user"
    }, {
      ...inboundCtx,
      runId: "run-tts"
    });

    emit(api, "agent_end", {}, {
      runId: "run-tts",
      sessionKey: inboundCtx.sessionKey
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sends.length, 1);
    assert.equal(sends[0].text, "这是最终文本回复");
    assert.equal(sends[0].audioArtifact, null);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
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

test("agent_end 先到时，迟到的 message_sent 仍会补发最终语音", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplySummaryEnabled: false
  }), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  const inboundCtx = createCtx({
    sessionKey: "agent:test:feishu:direct:ou_test_user_late_text"
  });
  emit(api, "inbound_claim", createInboundEvent({
    chatId: "ou_test_user_late_text",
    messageId: "om_test_inbound_late_text"
  }), inboundCtx);

  emit(api, "agent_end", { success: true }, {
    ...inboundCtx,
    runId: "run-late-message-sent"
  });

  emit(api, "message_sent", {
    success: true,
    text: "这是迟到但应该发语音的最终文本。",
    to: "user:ou_test_user_late_text"
  }, {
    ...inboundCtx,
    runId: "run-late-message-sent"
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "这是迟到但应该发语音的最终文本。");
});

test("agent_end 先到且文本钩子只有 transcript echo 时，迟到的 assistant 最终文本仍会走 no_text_fallback 发语音", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyDebounceMs: 0,
    voiceReplyNoTextFallbackMs: 0,
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

  const ctx = createCtx({
    runId: "run-late-assistant-no-text",
    conversationId: "user:ou_test_user_late_assistant",
    sessionKey: "agent:test:feishu:direct:ou_test_user_late_assistant"
  });

  emit(api, "inbound_claim", createInboundEvent({
    chatId: "ou_test_user_late_assistant",
    messageId: "om_test_inbound_late_assistant",
    metadata: {
      mediaType: "audio/ogg"
    }
  }), ctx);
  emit(api, "message_sending", {
    to: "user:ou_test_user_late_assistant",
    content: "📝 用户刚才的语音转写"
  }, ctx);
  emit(api, "message_sent", {
    success: true,
    text: "📝 用户刚才的语音转写",
    to: "user:ou_test_user_late_assistant"
  }, ctx);
  emit(api, "agent_end", { success: true }, ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "这是迟到但应该补发的最终语音文本。" }]
    }
  }, ctx);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "这是迟到但应该补发的最终语音文本。");
});

test("always 模式下即使没有 message_sent/message_sending，也会回退到 assistant 最终文本发语音", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "always",
    voiceReplyDebounceMs: 0,
    voiceReplyNoTextFallbackMs: 0
  }), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  const ctx = createCtx({
    runId: "run-text-only-fallback",
    sessionKey: "agent:test:feishu:direct:ou_test_user_text_only"
  });

  emit(api, "inbound_claim", createInboundEvent({
    chatId: "ou_test_user_text_only",
    messageId: "om_test_text_only"
  }), ctx);
  emit(api, "agent_end", { success: true }, ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "这是一条纯文本消息，也应该补发语音。" }]
    }
  }, ctx);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "这是一条纯文本消息，也应该补发语音。");
});

test("同一入站消息若后续事件才补齐语音元数据，仍会标记 voice inbound 并触发 no_text_fallback", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyDebounceMs: 0,
    voiceReplyNoTextFallbackMs: 0,
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

  const ctx = createCtx({
    runId: "run-voice-upgrade",
    conversationId: "user:ou_test_user_voice_upgrade",
    sessionKey: "agent:test:feishu:direct:ou_test_user_voice_upgrade"
  });

  emit(api, "inbound_claim", createInboundEvent({
    chatId: "ou_test_user_voice_upgrade",
    messageId: "om_test_voice_upgrade"
  }), ctx);
  emit(api, "message_received", createInboundEvent({
    chatId: "ou_test_user_voice_upgrade",
    messageId: "om_test_voice_upgrade",
    metadata: {
      mediaType: "audio/ogg"
    }
  }), ctx);
  emit(api, "message_sending", {
    to: "user:ou_test_user_voice_upgrade",
    content: "📝 升级后的语音转写"
  }, ctx);
  emit(api, "message_sent", {
    success: true,
    text: "📝 升级后的语音转写",
    to: "user:ou_test_user_voice_upgrade"
  }, ctx);
  emit(api, "agent_end", { success: true }, ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "补齐语音元数据后也应该发送最终语音。" }]
    }
  }, ctx);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "补齐语音元数据后也应该发送最终语音。");
});

test("/new 稀疏链路里 message_sent 与 assistant_message 分属不同 runKey 时，仍会复用同一 pending 并发送最终语音", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplySummaryEnabled: false
  }), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    },
    setTimer: timers.setTimer
  });

  const inboundCtx = createCtx({
    sessionKey: "agent:ceo:feishu:direct:ou_test_user"
  });
  emit(api, "inbound_claim", createInboundEvent(), inboundCtx);

  emit(api, "message_sent", {
    success: true,
    text: "这是 /new 的最终欢迎语",
    to: "user:ou_test_user"
  }, {
    ...inboundCtx,
    runId: "ou_test_user:fallback-run"
  });

  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "这是 /new 的最终欢迎语" }]
    }
  }, {
    ...inboundCtx,
    runId: "agent:ceo:feishu:direct:ou_test_user:fallback-run"
  });

  emit(api, "agent_end", {}, {
    ...inboundCtx,
    runId: "agent:ceo:feishu:direct:ou_test_user:fallback-run"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "这是 /new 的最终欢迎语");
});

test("跨插件实例时，message_sent 与 assistant_message 仍共享同一语音状态并最终发送", async () => {
  const sends = [];
  const timersA = createTimerHarness();
  const timersB = createTimerHarness();
  const apiA = createApi();
  const apiB = createApi();

  registerVoiceReplyHooks(apiA, createConfig({
    voiceReplyMode: "inbound",
    voiceReplySummaryEnabled: false
  }), {
    setTimer: timersA.setTimer,
    clearTimer: timersA.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  registerVoiceReplyHooks(apiB, createConfig({
    voiceReplyMode: "inbound",
    voiceReplySummaryEnabled: false
  }), {
    setTimer: timersB.setTimer,
    clearTimer: timersB.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  const inboundCtx = createCtx({
    sessionKey: "agent:ceo:feishu:direct:ou_test_user"
  });

  emit(apiA, "inbound_claim", createInboundEvent(), inboundCtx);
  emit(apiA, "message_sent", {
    success: true,
    text: "跨实例 /new 最终欢迎语",
    to: "user:ou_test_user"
  }, {
    accountId: "default",
    channelId: "feishu",
    conversationId: "user:ou_test_user"
  });

  emit(apiB, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "跨实例 /new 最终欢迎语" }]
    }
  }, inboundCtx);
  emit(apiB, "agent_end", { success: true }, inboundCtx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "跨实例 /new 最终欢迎语");
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

  emit(api, "message_sent", {
    success: true,
    text: "第一句介绍一下背景，并且包含大量细节文字，使得这一段非常长，明显超过语音上限。第二句继续给出详细结论，并且同样很长很长，仍然在扩写细节。第三句提供额外说明，也写得很长。",
    to: "user:ou_test_user"
  }, inboundCtx);

  emit(api, "agent_end", {}, { sessionKey: inboundCtx.sessionKey });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sends.length, 1);
  assert.ok(sends[0].text.startsWith("Summary:"));
  assert.ok(sends[0].text.length <= 50);
});

test("即使 message_sent 和 assistant 的标识不同，也会合并到同一个待发送回复", async () => {
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

  assert.equal(timers.timers.length, 0);
  emit(api, "agent_end", {}, { runId: "run-123", sessionKey: "agent:test:feishu:direct:ou_test_user" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "这是最终文本回复");
  assert.equal(sends[0].replyToMessageId, "om_test_inbound");
});

test("后续上下文稀疏时，assistant 最终文本仍可复用最近一次入站元数据", async () => {
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

  emit(api, "message_sent", {
    success: true,
    text: "这是来自稀疏上下文的语音回复",
    to: "user:ou_test_user"
  }, {
    accountId: "default",
    runId: "run-sparse",
    channelId: "feishu",
    conversationId: "user:ou_test_user",
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

  emit(api, "message_sent", {
    success: true,
    text: "收到您的语音消息。继续使用语音模式进行回复。",
    to: "user:ou_test_user"
  }, {
    accountId: "default",
    channelId: "feishu",
    conversationId: "user:ou_test_user",
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

  emit(api, "message_sent", {
    success: true,
    text: "最终语音回复文本",
    to: "user:ou_test_user"
  }, {
    accountId: "default",
    channelId: "feishu",
    conversationId: "user:ou_test_user",
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

test("过期的 inbound 窗口不会因为 replyToMessageId 被长期绕过", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;

  try {
    registerVoiceReplyHooks(api, createConfig({
      voiceReplyMode: "inbound",
      voiceReplyWindowMs: 1000,
      voiceReplyDebounceMs: 0
    }), {
      clearTimer: timers.clearTimer,
      setTimer: timers.setTimer,
      sendVoiceReplyImpl: async (_config, _logger, params) => {
        sends.push(params);
        return true;
      }
    });

    emit(api, "inbound_claim", createInboundEvent(), createCtx());
    now += 5000;

    emit(api, "before_message_write", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "这是一条已经超窗的回复" }]
      }
    }, {
      accountId: "default",
      sessionKey: "agent:test:feishu:direct:ou_test_user"
    });

    emit(api, "agent_end", { success: true }, {
      sessionKey: "agent:test:feishu:direct:ou_test_user"
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sends.length, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("agent_end 后会按 debounce 延迟发送语音", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyDebounceMs: 120
  }), {
    clearTimer: timers.clearTimer,
    setTimer: timers.setTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  emit(api, "inbound_claim", createInboundEvent(), createCtx());
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "这是需要延迟发送的最终回复" }]
    }
  }, {
    accountId: "default",
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  });

  emit(api, "message_sent", {
    success: true,
    text: "这是需要延迟发送的最终回复",
    to: "user:ou_test_user"
  }, createCtx());

  emit(api, "agent_end", { success: true }, {
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  });

  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].ms, 120);
  assert.equal(sends.length, 0);

  await timers.timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "这是需要延迟发送的最终回复");
});

test("后台语音发送失败后会按 backoff 重试", async () => {
  const logs = [];
  const api = createApi({
    info(message) {
      logs.push(`info:${message}`);
    },
    warn(message) {
      logs.push(`warn:${message}`);
    }
  });
  const timers = createTimerHarness();
  const attempts = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyRetryCount: 2,
    voiceReplyRetryBackoffMs: 80
  }), {
    clearTimer: timers.clearTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      attempts.push(params.text);
      if (attempts.length === 1) {
        throw new Error("transient upload error");
      }
      return true;
    },
    setTimer: timers.setTimer
  });

  emit(api, "inbound_claim", createInboundEvent(), createCtx());
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "这是一条需要重试的语音回复" }]
    }
  }, {
    accountId: "default",
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  });
  emit(api, "message_sent", {
    success: true,
    text: "这是一条需要重试的语音回复",
    to: "user:ou_test_user"
  }, createCtx());
  emit(api, "agent_end", { success: true }, {
    sessionKey: "agent:test:feishu:direct:ou_test_user"
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts.length, 1);
  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].ms, 80);
  assert.ok(logs.some((line) => line.includes("scheduling retry")));

  await timers.timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts.length, 2);
  assert.ok(logs.some((line) => line.includes("queue enqueued")));
  assert.ok(logs.some((line) => line.includes("auto reply sent")));
});

test("多次 assistant 写入时，最后一条最终文本仍保持最高优先级", async () => {
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
  emit(api, "message_sent", {
    success: true,
    text: "最终文本版本",
    to: "user:ou_test_user"
  }, createCtx({ runId: "run-session-fallback", sessionKey: "agent:test:feishu:direct:ou_test_user" }));
  assert.equal(timers.timers.length, 0);
  emit(api, "agent_end", {}, { runId: "run-session-fallback", sessionKey: "agent:test:feishu:direct:ou_test_user" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "最终文本版本");
});

test("message_sent 最终文本优先于 assistant 中间态文本", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyDebounceMs: 0
  }), {
    clearTimer: timers.clearTimer,
    setTimer: timers.setTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  const ctx = createCtx({ runId: "run-final-wins" });
  emit(api, "inbound_claim", createInboundEvent(), ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "收到，我先查一下，请稍等。" }]
    }
  }, ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "我先给您分析一下，马上返回结果。" }]
    }
  }, ctx);
  emit(api, "message_sent", {
    success: true,
    text: "富阳区明天多云转晴，12 到 21 度，东北风 2 级。",
    to: "user:ou_test_user"
  }, ctx);
  emit(api, "agent_end", { success: true }, ctx);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "富阳区明天多云转晴，12 到 21 度，东北风 2 级。");
});

test("/new 状态型 message_sent 不再覆盖后续 assistant 最终正文", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyDebounceMs: 0,
    voiceReplySummaryEnabled: false
  }), {
    clearTimer: timers.clearTimer,
    setTimer: timers.setTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  const ctx = createCtx({ runId: "run-new-status" });
  emit(api, "inbound_claim", createInboundEvent(), ctx);
  emit(api, "message_sent", {
    success: true,
    text: "收到，正在为您初始化新会话，请稍等。",
    to: "user:ou_test_user"
  }, ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "新会话已经准备好了，我们继续开始今天的任务。" }]
    }
  }, ctx);
  emit(api, "agent_end", { success: true }, ctx);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "新会话已经准备好了，我们继续开始今天的任务。");
});

test("/new 英文 session started 状态文案不再覆盖后续 assistant 最终正文", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyDebounceMs: 0,
    voiceReplySummaryEnabled: false
  }), {
    clearTimer: timers.clearTimer,
    setTimer: timers.setTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  const ctx = createCtx({ runId: "run-new-status-en" });
  emit(api, "inbound_claim", createInboundEvent(), ctx);
  emit(api, "message_sent", {
    success: true,
    text: "✅ New session started · model: huawei-cloud/glm-5",
    to: "user:ou_test_user"
  }, ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "新会话已经准备好了，我们继续开始今天的任务。" }]
    }
  }, ctx);
  emit(api, "agent_end", { success: true }, ctx);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "新会话已经准备好了，我们继续开始今天的任务。");
});

test("没有最终 message_sent 文本时优先使用 tts_tool 文本", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-tool-priority-"));
  const filePath = path.join(tmpRoot, "reply.wav");
  const wavBuffer = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x2c, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
    0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  ]);
  fs.writeFileSync(filePath, wavBuffer);

  try {
    registerVoiceReplyHooks(api, createConfig({
      voiceReplyMode: "inbound",
      voiceReplyDebounceMs: 0
    }), {
      clearTimer: timers.clearTimer,
      setTimer: timers.setTimer,
      sendVoiceReplyImpl: async (_config, _logger, params) => {
        sends.push(params);
        return true;
      }
    });

    const ctx = createCtx({ runId: "run-tool-wins" });
    emit(api, "inbound_claim", createInboundEvent(), ctx);
    emit(api, "message_sent", {
      success: true,
      payload: {}
    }, ctx);
    emit(api, "after_tool_call", {
      toolName: "tts",
      params: { text: "最终结论是明天有小雨，出门记得带伞。" },
      result: { audioPath: filePath }
    }, ctx);
    emit(api, "before_message_write", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "收到，我先帮您看一下天气。" }]
      }
    }, ctx);
    emit(api, "agent_end", { success: true }, ctx);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sends.length, 1);
    assert.equal(sends[0].text, "最终结论是明天有小雨，出门记得带伞。");
    assert.equal(sends[0].audioArtifact, null);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("message_sent 文本缺失时仍能解锁同 session 的语音发送", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyDebounceMs: 0
  }), {
    clearTimer: timers.clearTimer,
    setTimer: timers.setTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  const ctx = createCtx({ runId: "run-textsent-session" });
  emit(api, "inbound_claim", createInboundEvent(), ctx);
  emit(api, "message_sent", {
    success: true,
    payload: {}
  }, ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "这是最终回复文本。" }]
    }
  }, ctx);
  emit(api, "agent_end", { success: true }, ctx);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "这是最终回复文本。");
});

test("没有 message_sent 时会回退到 message_sending 兜底触发语音", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyDebounceMs: 0,
    voiceReplyTextSendingFallbackMs: 0,
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
    setTimer: timers.setTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  const ctx = createCtx({ runId: "run-message-sending-fallback" });
  emit(api, "inbound_claim", createInboundEvent(), ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "这是最终回复文本。" }]
    }
  }, ctx);
  emit(api, "message_sending", {
    to: "user:ou_test_user",
    content: "这是最终回复文本。"
  }, ctx);
  emit(api, "agent_end", { success: true }, ctx);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "这是最终回复文本。");
});

test("转写回显型 message_sent 不会提前解锁语音发送", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyDebounceMs: 0,
    voiceReplyTextSendingFallbackMs: 0
  }), {
    clearTimer: timers.clearTimer,
    setTimer: timers.setTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  const ctx = createCtx({
    runId: "run-transcript-echo-lock",
    conversationId: "user:ou_test_user_transcript_lock",
    sessionKey: "agent:test:feishu:direct:ou_test_user_transcript_lock"
  });

  emit(api, "inbound_claim", createInboundEvent({
    chatId: "ou_test_user_transcript_lock",
    messageId: "om_test_inbound_transcript_lock"
  }), ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "老板，最终结果已经查到了。" }]
    }
  }, ctx);
  emit(api, "message_sent", {
    success: true,
    text: "📝 老板，最终结果已经查到了。",
    to: "user:ou_test_user_transcript_lock"
  }, ctx);
  emit(api, "agent_end", { success: true }, ctx);

  assert.equal(sends.length, 0);

  emit(api, "message_sending", {
    to: "user:ou_test_user_transcript_lock",
    content: "老板，最终结果已经查到了。"
  }, ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "老板，最终结果已经查到了。");
});

test("转写回显型 message_sending 不会覆盖最终 assistant 语音内容", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyDebounceMs: 0,
    voiceReplyTextSendingFallbackMs: 0,
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
    setTimer: timers.setTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  const ctx = createCtx({
    runId: "run-message-sending-echo",
    conversationId: "user:ou_test_user_msg_sending_echo",
    sessionKey: "agent:test:feishu:direct:ou_test_user_msg_sending_echo"
  });

  emit(api, "inbound_claim", createInboundEvent({
    chatId: "ou_test_user_msg_sending_echo",
    messageId: "om_test_inbound_msg_sending_echo"
  }), ctx);
  emit(api, "message_sending", {
    to: "user:ou_test_user_msg_sending_echo",
    content: "📝 今天天气怎么样"
  }, ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "老板，今天多云，最高温 26 度。" }]
    }
  }, ctx);
  emit(api, "message_sending", {
    to: "user:ou_test_user_msg_sending_echo",
    content: "老板，今天多云，最高温 26 度。"
  }, ctx);
  emit(api, "agent_end", { success: true }, ctx);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "老板，今天多云，最高温 26 度。");
});

test("语音入站场景里若文本钩子只出现转写回显，agent_end 后会回退到 assistant 最终文本发语音", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyDebounceMs: 0,
    voiceReplyNoTextFallbackMs: 0,
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
    setTimer: timers.setTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  const ctx = createCtx({
    runId: "run-no-text-fallback",
    conversationId: "user:ou_test_user_no_text_fallback",
    sessionKey: "agent:test:feishu:direct:ou_test_user_no_text_fallback"
  });

  emit(api, "inbound_claim", createInboundEvent({
    chatId: "ou_test_user_no_text_fallback",
    messageId: "om_test_inbound_no_text_fallback",
    body: "[audio]",
    metadata: {
      mediaType: "audio/ogg"
    }
  }), ctx);
  emit(api, "message_sending", {
    to: "user:ou_test_user_no_text_fallback",
    content: "📝 帮我查一下今天的天气"
  }, ctx);
  emit(api, "message_sent", {
    success: true,
    text: "📝 帮我查一下今天的天气",
    to: "user:ou_test_user_no_text_fallback"
  }, ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "老板，今天多云，最高温 26 度，晚点会转晴。" }]
    }
  }, ctx);
  emit(api, "agent_end", { success: true }, ctx);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "老板，今天多云，最高温 26 度，晚点会转晴。");
});

test("纯文本入站即使跳过转写回显，也不会启用无文本钩子兜底语音", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyDebounceMs: 0,
    voiceReplyNoTextFallbackMs: 0,
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
    setTimer: timers.setTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  const ctx = createCtx({
    runId: "run-no-text-fallback-text-only",
    conversationId: "user:ou_test_user_no_text_fallback_text_only",
    sessionKey: "agent:test:feishu:direct:ou_test_user_no_text_fallback_text_only"
  });

  emit(api, "inbound_claim", createInboundEvent({
    chatId: "ou_test_user_no_text_fallback_text_only",
    messageId: "om_test_inbound_no_text_fallback_text_only",
    body: "帮我查一下今天的天气"
  }), ctx);
  emit(api, "message_sent", {
    success: true,
    text: "📝 帮我查一下今天的天气",
    to: "user:ou_test_user_no_text_fallback_text_only"
  }, ctx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "老板，今天多云，最高温 26 度，晚点会转晴。" }]
    }
  }, ctx);
  emit(api, "agent_end", { success: true }, ctx);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 0);
});

test("/new 场景下即使后续事件只带 runId，也会在文本发出后立刻触发语音", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplyDebounceMs: 0
  }), {
    clearTimer: timers.clearTimer,
    setTimer: timers.setTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  const inboundCtx = createCtx({ runId: "run-new-init" });
  emit(api, "inbound_claim", createInboundEvent(), inboundCtx);
  emit(api, "before_dispatch", {}, inboundCtx);

  const runOnlyCtx = {
    accountId: "default",
    channelId: "feishu",
    runId: "run-new-init"
  };

  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "欢迎回来，我们开始新的会话。" }]
    }
  }, runOnlyCtx);

  emit(api, "message_sent", {
    success: true,
    payload: { text: "欢迎回来，我们开始新的会话。" }
  }, runOnlyCtx);

  emit(api, "agent_end", { success: true }, runOnlyCtx);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, "ou_test_user");
  assert.equal(sends[0].text, "欢迎回来，我们开始新的会话。");
});

test("新入站消息会清理同 session 的旧 pending，避免提前发出上一轮语音", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-stale-session-"));
  const filePath = path.join(tmpRoot, "reply.wav");
  const wavBuffer = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x2c, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
    0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  ]);
  fs.writeFileSync(filePath, wavBuffer);

  try {
    registerVoiceReplyHooks(api, createConfig({
      voiceReplyMode: "inbound",
      voiceReplyDebounceMs: 0
    }), {
      clearTimer: timers.clearTimer,
      setTimer: timers.setTimer,
      sendVoiceReplyImpl: async (_config, _logger, params) => {
        sends.push(params);
        return true;
      }
    });

    const sessionCtx = createCtx({ sessionKey: "agent:test:feishu:direct:ou_test_user" });

    emit(api, "inbound_claim", createInboundEvent({ messageId: "om_old" }), sessionCtx);
    emit(api, "before_message_write", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "旧的一轮里残留的中间回复" }]
      }
    }, {
      ...sessionCtx,
      runId: "run-old"
    });

    emit(api, "inbound_claim", createInboundEvent({ messageId: "om_new" }), sessionCtx);
    emit(api, "message_sent", {
      success: true,
      payload: {}
    }, {
      ...sessionCtx,
      runId: "run-new"
    });
    emit(api, "after_tool_call", {
      toolName: "tts",
      params: { text: "这是新一轮的最终语音内容。" },
      result: { audioPath: filePath }
    }, {
      ...sessionCtx,
      runId: "run-new"
    });
    emit(api, "before_message_write", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "收到，我来查一下。" }]
      }
    }, {
      ...sessionCtx,
      runId: "run-new"
    });
    emit(api, "agent_end", { success: true }, {
      ...sessionCtx,
      runId: "run-new"
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sends.length, 1);
    assert.equal(sends[0].text, "这是新一轮的最终语音内容。");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("同一入站语音消息在首次自动语音发送后，不会再被后续 assistant 波动重复发送", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];

  registerVoiceReplyHooks(api, createConfig({
    voiceReplyMode: "inbound",
    voiceReplySummaryEnabled: false,
    voiceReplyDebounceMs: 0
  }), {
    clearTimer: timers.clearTimer,
    setTimer: timers.setTimer,
    sendVoiceReplyImpl: async (_config, _logger, params) => {
      sends.push(params);
      return true;
    }
  });

  const voiceCtx = createCtx({ runId: "run-voice-once" });
  emit(api, "inbound_claim", createInboundEvent({ messageId: "om_voice_once" }), voiceCtx);
  emit(api, "message_sent", {
    success: true,
    text: "第一版最终文本",
    to: "user:ou_test_user"
  }, voiceCtx);
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "第一版最终文本" }]
    }
  }, voiceCtx);
  emit(api, "agent_end", { success: true }, voiceCtx);
  await new Promise((resolve) => setImmediate(resolve));

  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "迟到的第二版文本" }]
    }
  }, voiceCtx);
  emit(api, "agent_end", { success: true }, voiceCtx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "第一版最终文本");
});

test("即使最终文本像进度提示，只要 agent_end 成功仍会发送语音", async () => {
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

  emit(api, "inbound_claim", createInboundEvent(), createCtx());
  emit(api, "before_message_write", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "收到您的测试语音。继续使用语音模式进行回复。" }]
    }
  }, ctx);
  emit(api, "message_sent", {
    success: true,
    text: "收到您的测试语音。继续使用语音模式进行回复。",
    to: "user:ou_test_user"
  }, createCtx({ runId: "run-progress-final", sessionKey: "agent:test:feishu:direct:ou_test_user" }));
  assert.equal(timers.timers.length, 0);
  emit(api, "agent_end", {}, { runId: "run-progress-final", sessionKey: "agent:test:feishu:direct:ou_test_user" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "收到您的测试语音。继续使用语音模式进行回复。");
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

  emit(api, "message_sent", {
    success: true,
    text: "老板，查到最终结果了。",
    to: "user:ou_test_user"
  }, createCtx({ sessionKey: "agent:test:feishu:direct:ou_test_user" }));

  assert.equal(timers.timers.length, 0);
  emit(api, "agent_end", {}, { sessionKey: "agent:test:feishu:direct:ou_test_user" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "老板，查到最终结果了。");
});

test("单独的 tts 工具调用不再直接驱动自动语音回复", async () => {
  const api = createApi();
  const timers = createTimerHarness();
  const sends = [];
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-tool-only-"));
  const filePath = path.join(tmpRoot, "reply.wav");
  const wavBuffer = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x2c, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
    0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  ]);

  fs.writeFileSync(filePath, wavBuffer);

  try {
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
    emit(api, "after_tool_call", {
      toolName: "tts",
      params: { text: "只有工具语音，没有最终文本" },
      result: { audioPath: filePath }
    }, {
      accountId: "default",
      runId: "run-tool-only",
      sessionKey: "agent:test:feishu:direct:ou_test_user"
    });

    emit(api, "agent_end", {}, {
      runId: "run-tool-only",
      sessionKey: "agent:test:feishu:direct:ou_test_user"
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(api.handlers.has("after_tool_call"), true);
    assert.equal(sends.length, 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
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
