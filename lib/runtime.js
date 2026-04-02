"use strict";

const fs = require("node:fs");
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
  const pathExistsImpl = typeof deps.pathExists === "function" ? deps.pathExists : fs.existsSync;
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
    hasScriptTts: pathExistsImpl(config.scriptPath),
    hasScriptStt: pathExistsImpl(config.sttScriptPath),
    hasFfmpeg: commandExistsImpl("ffmpeg"),
    hasFfprobe: commandExistsImpl("ffprobe"),
    hasEdgeTts: commandExistsImpl("edge-tts"),
    hasWhisper: commandExistsImpl("whisper")
  };

  runtime.summary = {
    tts: runtime.hasNativeTts ? `native:${nativeTtsProvider}` : "unavailable",
    stt: runtime.hasNativeStt ? "native:media-understanding" : runtime.hasScriptStt ? "script" : "unavailable",
    summary: runtime.hasNativeSummary ? "native:tts-summary" : "rule-only",
    scriptTts: runtime.hasScriptTts,
    scriptStt: runtime.hasScriptStt,
    ffmpeg: runtime.hasFfmpeg,
    ffprobe: runtime.hasFfprobe
  };

  runtime.dependencyWarnings = [];
  if (runtime.hasScriptTts && !runtime.hasEdgeTts) {
    runtime.dependencyWarnings.push("script TTS enabled but `edge-tts` is unavailable");
  }
  if (runtime.hasScriptTts && !runtime.hasFfmpeg) {
    runtime.dependencyWarnings.push("script TTS enabled but `ffmpeg` is unavailable");
  }
  if ((runtime.hasScriptTts || runtime.hasNativeTts) && !runtime.hasFfprobe) {
    runtime.dependencyWarnings.push("audio duration probe requires `ffprobe`");
  }
  if (runtime.hasScriptStt && !runtime.hasWhisper) {
    runtime.dependencyWarnings.push("script STT enabled but `whisper` is unavailable");
  }
  if (runtime.hasScriptStt && !runtime.hasFfmpeg) {
    runtime.dependencyWarnings.push("script STT enabled but `ffmpeg` is unavailable");
  }

  return runtime;
}

function logRuntimeReadiness(runtime, logger) {
  if (!runtime || !logger?.info) return;
  logger.info(
    `[feishu-voice] runtime ready: nativeTts=${runtime.summary.tts}, nativeStt=${runtime.summary.stt}, summary=${runtime.summary.summary}, scriptTts=${runtime.summary.scriptTts}, scriptStt=${runtime.summary.scriptStt}, ffmpeg=${runtime.summary.ffmpeg}, ffprobe=${runtime.summary.ffprobe}`
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
