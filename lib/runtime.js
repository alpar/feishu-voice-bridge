"use strict";

const { execFileSync } = require("node:child_process");

const {
  loadOpenClawSummaryApi,
  loadOpenClawSpeechRuntime,
  resolvePreferredNativeTtsProvider
} = require("./core-bridge");

function resolveNativeAudioTranscriber(coreRuntime) {
  if (typeof coreRuntime?.mediaUnderstanding?.transcribeAudioFile === "function") {
    return coreRuntime.mediaUnderstanding.transcribeAudioFile.bind(coreRuntime.mediaUnderstanding);
  }
  if (typeof coreRuntime?.stt?.transcribeAudioFile === "function") {
    return coreRuntime.stt.transcribeAudioFile.bind(coreRuntime.stt);
  }
  return null;
}

function commandExists(command, deps = {}) {
  if (typeof command !== "string" || !command.trim()) return false;
  const execFileSyncImpl = typeof deps.execFileSyncImpl === "function" ? deps.execFileSyncImpl : execFileSync;
  const platform = typeof deps.platform === "string" && deps.platform.trim() ? deps.platform.trim() : process.platform;
  const locatorCommand = platform === "win32" ? "where.exe" : "which";
  try {
    execFileSyncImpl(locatorCommand, [command], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 3000
    });
    return true;
  } catch {
    return false;
  }
}

function hasNativeSttRuntime(coreRuntime) {
  return typeof resolveNativeAudioTranscriber(coreRuntime) === "function";
}

function createPluginRuntime(config, coreRuntime = null, deps = {}) {
  const commandExistsImpl = typeof deps.commandExists === "function" ? deps.commandExists : commandExists;
  const loadSpeechRuntimeImpl = typeof deps.loadSpeechRuntime === "function"
    ? deps.loadSpeechRuntime
    : loadOpenClawSpeechRuntime;
  const loadSummaryApiImpl = typeof deps.loadSummaryApi === "function"
    ? deps.loadSummaryApi
    : loadOpenClawSummaryApi;
  const resolvePreferredNativeTtsProviderImpl = typeof deps.resolvePreferredNativeTtsProvider === "function"
    ? deps.resolvePreferredNativeTtsProvider
    : resolvePreferredNativeTtsProvider;
  const speechRuntimeState = {
    loaded: false,
    loading: false
  };
  const runtime = {
    coreRuntime,
    speechRuntime: null,
    summaryApi: null,
    nativeTtsProvider: "",
    hasNativeTts: false,
    hasNativeStt: !!config?.gatewayConfig && hasNativeSttRuntime(coreRuntime),
    hasNativeSummary: false,
    nativeProbeState: config?.gatewayConfig ? "deferred" : "unavailable",
    hasFfmpeg: commandExistsImpl("ffmpeg"),
    hasFfprobe: commandExistsImpl("ffprobe"),
    hasEdgeTts: commandExistsImpl("edge-tts"),
    hasWhisper: commandExistsImpl("whisper")
  };
  runtime.hasToolTts = runtime.hasEdgeTts && runtime.hasFfmpeg;
  runtime.hasToolStt = runtime.hasWhisper && runtime.hasFfmpeg;
  runtime.getSpeechRuntime = () => {
    if (!config?.gatewayConfig) return null;
    if (speechRuntimeState.loaded) return runtime.speechRuntime;
    if (speechRuntimeState.loading) return null;

    speechRuntimeState.loading = true;
    try {
      runtime.speechRuntime = loadSpeechRuntimeImpl() || null;
      speechRuntimeState.loaded = true;
      return runtime.speechRuntime;
    } finally {
      speechRuntimeState.loading = false;
    }
  };
  runtime.ensureNativeCapabilities = () => {
    if (!config?.gatewayConfig) {
      runtime.nativeProbeState = "unavailable";
      return runtime;
    }

    const speechRuntime = runtime.getSpeechRuntime();
    if (!speechRuntimeState.loaded) {
      return runtime;
    }

    if (!speechRuntime) {
      runtime.nativeTtsProvider = "";
      runtime.hasNativeTts = false;
      runtime.summaryApi = loadSummaryApiImpl() || null;
      runtime.hasNativeSummary = typeof runtime.summaryApi?.summarizeText === "function";
      runtime.nativeProbeState = "unavailable";
      return runtime;
    }

    runtime.nativeTtsProvider = resolvePreferredNativeTtsProviderImpl(speechRuntime, config.gatewayConfig);
    runtime.hasNativeTts = !!runtime.nativeTtsProvider;
    runtime.summaryApi = loadSummaryApiImpl() || null;
    runtime.hasNativeSummary = typeof speechRuntime?.summarizeText === "function"
      || typeof runtime.summaryApi?.summarizeText === "function"
      || typeof speechRuntime?._test?.summarizeText === "function";
    runtime.nativeProbeState = "ready";
    return runtime;
  };

  runtime.summary = {
    get tts() {
      if (runtime.hasNativeTts) return `native:${runtime.nativeTtsProvider}`;
      if (runtime.nativeProbeState === "deferred") return runtime.hasToolTts ? "toolchain:edge-tts" : "native:deferred";
      return runtime.hasToolTts ? "toolchain:edge-tts" : "unavailable";
    },
    get stt() {
      return runtime.hasNativeStt ? "native:media-understanding" : runtime.hasToolStt ? "toolchain:whisper" : "unavailable";
    },
    get summary() {
      if (runtime.hasNativeSummary) return "native:tts-summary";
      return runtime.nativeProbeState === "deferred" ? "native:deferred" : "rule-only";
    },
    toolTts: runtime.hasToolTts,
    toolStt: runtime.hasToolStt,
    ffmpeg: runtime.hasFfmpeg,
    ffprobe: runtime.hasFfprobe
  };

  runtime.dependencyWarnings = [];
  if (!runtime.hasEdgeTts) {
    runtime.dependencyWarnings.push("local TTS toolchain disabled: `edge-tts` unavailable");
  }
  if (!runtime.hasFfmpeg) {
    runtime.dependencyWarnings.push("local TTS toolchain disabled: `ffmpeg` unavailable");
  }
  if (!runtime.hasFfprobe) {
    runtime.dependencyWarnings.push("audio duration probe requires `ffprobe`");
  }
  if (!runtime.hasWhisper) {
    runtime.dependencyWarnings.push("local STT toolchain disabled: `whisper` unavailable");
  }
  if (!runtime.hasFfmpeg) {
    runtime.dependencyWarnings.push("local STT toolchain disabled: `ffmpeg` unavailable");
  }

  return runtime;
}

function logRuntimeReadiness(runtime, logger) {
  if (!runtime || !logger?.info) return;
  logger.info(
    `[feishu-voice] runtime ready: tts=${runtime.summary.tts}, stt=${runtime.summary.stt}, summary=${runtime.summary.summary}, toolTts=${runtime.summary.toolTts}, toolStt=${runtime.summary.toolStt}, ffmpeg=${runtime.summary.ffmpeg}, ffprobe=${runtime.summary.ffprobe}`
  );
  if (!logger?.warn) return;
  for (const warning of Array.isArray(runtime.dependencyWarnings) ? runtime.dependencyWarnings : []) {
    logger.warn(`[feishu-voice] dependency warning: ${warning}`);
  }
}

module.exports = {
  commandExists,
  createPluginRuntime,
  hasNativeSttRuntime,
  logRuntimeReadiness,
  resolveNativeAudioTranscriber
};
