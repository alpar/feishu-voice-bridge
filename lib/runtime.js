"use strict";

const { execFileSync } = require("node:child_process");

const {
  loadOpenClawSpeechRuntime,
  resolvePreferredNativeTtsProvider
} = require("./core-bridge");

function commandExists(command) {
  if (typeof command !== "string" || !command.trim()) return false;
  try {
    execFileSync("which", [command], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 3000
    });
    return true;
  } catch {
    return false;
  }
}

function hasNativeSttRuntime(coreRuntime) {
  return typeof coreRuntime?.stt?.transcribeAudioFile === "function";
}

function createPluginRuntime(config, coreRuntime = null, deps = {}) {
  const commandExistsImpl = typeof deps.commandExists === "function" ? deps.commandExists : commandExists;
  const speechRuntime = config?.gatewayConfig ? loadOpenClawSpeechRuntime() : null;
  const nativeTtsProvider = speechRuntime && config?.gatewayConfig
    ? resolvePreferredNativeTtsProvider(speechRuntime, config.gatewayConfig)
    : "";
  const runtime = {
    coreRuntime,
    speechRuntime,
    nativeTtsProvider,
    hasNativeTts: !!nativeTtsProvider,
    hasNativeStt: !!config?.gatewayConfig && hasNativeSttRuntime(coreRuntime),
    hasNativeSummary: !!speechRuntime?._test?.summarizeText,
    hasFfmpeg: commandExistsImpl("ffmpeg"),
    hasFfprobe: commandExistsImpl("ffprobe"),
    hasEdgeTts: commandExistsImpl("edge-tts"),
    hasWhisper: commandExistsImpl("whisper")
  };
  runtime.hasToolTts = runtime.hasEdgeTts && runtime.hasFfmpeg;
  runtime.hasToolStt = runtime.hasWhisper && runtime.hasFfmpeg;

  runtime.summary = {
    tts: runtime.hasNativeTts ? `native:${nativeTtsProvider}` : runtime.hasToolTts ? "toolchain:edge-tts" : "unavailable",
    stt: runtime.hasNativeStt ? "native:media-understanding" : runtime.hasToolStt ? "toolchain:whisper" : "unavailable",
    summary: runtime.hasNativeSummary ? "native:tts-summary" : "rule-only",
    toolTts: runtime.hasToolTts,
    toolStt: runtime.hasToolStt,
    ffmpeg: runtime.hasFfmpeg,
    ffprobe: runtime.hasFfprobe
  };

  runtime.dependencyWarnings = [];
  if (!runtime.hasNativeTts && !runtime.hasToolTts && !runtime.hasEdgeTts) {
    runtime.dependencyWarnings.push("local TTS toolchain requires `edge-tts`");
  }
  if (!runtime.hasNativeTts && !runtime.hasToolTts && !runtime.hasFfmpeg) {
    runtime.dependencyWarnings.push("local TTS toolchain requires `ffmpeg`");
  }
  if ((runtime.hasToolTts || runtime.hasNativeTts) && !runtime.hasFfprobe) {
    runtime.dependencyWarnings.push("audio duration probe requires `ffprobe`");
  }
  if (!runtime.hasNativeStt && !runtime.hasToolStt && !runtime.hasWhisper) {
    runtime.dependencyWarnings.push("local STT toolchain requires `whisper`");
  }
  if (!runtime.hasNativeStt && !runtime.hasToolStt && !runtime.hasFfmpeg) {
    runtime.dependencyWarnings.push("local STT toolchain requires `ffmpeg`");
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
  createPluginRuntime,
  hasNativeSttRuntime,
  logRuntimeReadiness
};
