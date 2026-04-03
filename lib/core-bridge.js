"use strict";

const { createRequire } = require("node:module");

const SPEECH_RUNTIME_MODULE_SPECS = [
  "openclaw/plugin-sdk/speech-runtime",
  "./plugin-sdk/speech-runtime.js"
];
const EXCLUDED_NATIVE_TTS_PROVIDERS = new Set(["feishu-voice"]);

function loadOpenClawSpeechRuntime() {
  const anchors = [
    typeof require.main?.filename === "string" ? require.main.filename : "",
    typeof process.argv?.[1] === "string" ? process.argv[1] : ""
  ].filter(Boolean);

  for (const anchor of anchors) {
    const runtimeRequire = createRequire(anchor);
    for (const spec of SPEECH_RUNTIME_MODULE_SPECS) {
      try {
        const runtime = runtimeRequire(spec);
        if (runtime?.synthesizeSpeech && typeof runtime.resolveTtsConfig === "function") {
          return runtime;
        }
      } catch {
        // 继续尝试下一个官方导出或兼容路径。
      }
    }
  }

  return null;
}

function resolvePreferredNativeTtsProvider(runtime, cfg, options = {}) {
  const excludedProviders = options.excludedProviders || EXCLUDED_NATIVE_TTS_PROVIDERS;
  if (!runtime?.resolveTtsConfig || !runtime?.resolveTtsPrefsPath || !runtime?.getTtsProvider || !runtime?.resolveTtsProviderOrder) {
    return "";
  }

  const ttsConfig = runtime.resolveTtsConfig(cfg);
  const prefsPath = runtime.resolveTtsPrefsPath(ttsConfig);
  const primary = runtime.getTtsProvider(ttsConfig, prefsPath);
  const providerOrder = runtime.resolveTtsProviderOrder(primary, cfg);

  for (const provider of providerOrder) {
    if (excludedProviders?.has?.(provider)) continue;
    if (typeof runtime.isTtsProviderConfigured === "function" && !runtime.isTtsProviderConfigured(ttsConfig, provider, cfg)) {
      continue;
    }
    return provider;
  }

  return "";
}

async function summarizeWithOpenClawTtsModel(params) {
  const runtime = typeof params?.loadSpeechRuntime === "function"
    ? params.loadSpeechRuntime()
    : loadOpenClawSpeechRuntime();
  if (!runtime?._test?.summarizeText || typeof runtime.resolveTtsConfig !== "function") {
    return null;
  }
  if (!params?.cfg || typeof params.cfg !== "object") {
    return null;
  }

  const ttsConfig = runtime.resolveTtsConfig(params.cfg);
  const result = await runtime._test.summarizeText({
    text: params.text,
    targetLength: params.targetLength,
    cfg: params.cfg,
    config: ttsConfig,
    timeoutMs: ttsConfig.timeoutMs
  }, params.summarizeTextDeps);
  const summary = typeof result?.summary === "string" ? result.summary.trim() : "";
  if (!summary) return null;

  return {
    text: summary,
    summaryModel: ttsConfig.summaryModel || "",
    source: "openclaw-tts"
  };
}

async function synthesizeWithOpenClawTts(params) {
  const runtime = typeof params?.loadSpeechRuntime === "function"
    ? params.loadSpeechRuntime()
    : loadOpenClawSpeechRuntime();
  if (!runtime?.synthesizeSpeech) {
    return null;
  }
  if (!params?.cfg || typeof params.cfg !== "object") {
    return null;
  }

  const preferredProvider = resolvePreferredNativeTtsProvider(runtime, params.cfg);
  if (!preferredProvider) {
    return null;
  }

  const result = await runtime.synthesizeSpeech({
    text: params.text,
    cfg: params.cfg,
    channel: params.channel || "feishu",
    overrides: {
      ...(params.overrides || {}),
      provider: preferredProvider
    },
    disableFallback: params.disableFallback ?? true
  });
  return result?.success ? result : null;
}

module.exports = {
  loadOpenClawSpeechRuntime,
  resolvePreferredNativeTtsProvider,
  summarizeWithOpenClawTtsModel,
  synthesizeWithOpenClawTts
};
