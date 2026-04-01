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
  loadGeneratedAudioArtifact,
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
    scriptPath: "/tmp/not-used",
    defaultVoice: "fallback-voice",
    defaultRate: "+20",
    defaultPitch: "0"
  }, {
    info() {},
    warn() {},
    error() {}
  }, {
    hasNativeTts: true,
    hasScriptTts: false
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
    gatewayConfig: {},
    scriptPath: "/tmp/not-used-tts.sh",
    sttScriptPath: "/tmp/not-used-stt.sh"
  }, {
    stt: {
      transcribeAudioFile: async () => ({ text: "ok" })
    }
  });

  assert.equal(runtime.hasNativeStt, true);
  assert.equal(typeof runtime.summary.stt, "string");
  assert.equal(runtime.summary.stt, "native:media-understanding");
});

test("buildMediaUnderstandingProvider 优先使用 OpenClaw 原生 STT runtime", async () => {
  const provider = buildMediaUnderstandingProvider({
    gatewayConfig: {},
    sttScriptPath: "/tmp/not-used-stt.sh",
    sttLanguage: "zh-CN",
    sttModel: "small"
  }, {
    info() {},
    warn() {},
    error() {}
  }, {
    hasNativeStt: true,
    hasScriptStt: false,
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

test("after_tool_call 捕获官方 tts 音频后，最终发送优先复用该音频", async () => {
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

    emit(api, "agent_end", {}, {
      runId: "run-tts",
      sessionKey: inboundCtx.sessionKey
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sends.length, 1);
    assert.equal(sends[0].text, "这是最终文本回复");
    assert.equal(sends[0].audioArtifact?.source, "tts-tool");
    assert.equal(sends[0].audioArtifact?.fileType, "wav");
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
  assert.equal(timers.timers.length, 0);
  emit(api, "agent_end", {}, { runId: "run-session-fallback", sessionKey: "agent:test:feishu:direct:ou_test_user" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "最终文本版本");
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
