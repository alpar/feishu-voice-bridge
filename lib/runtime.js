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

function createPluginRuntime(config, coreRuntime = null) {
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
    hasScriptTts: fs.existsSync(config.scriptPath),
    hasScriptStt: fs.existsSync(config.sttScriptPath),
    hasFfprobe: commandExists("ffprobe")
  };

  runtime.summary = {
    tts: runtime.hasNativeTts ? `native:${nativeTtsProvider}` : "unavailable",
    stt: runtime.hasNativeStt ? "native:media-understanding" : runtime.hasScriptStt ? "script" : "unavailable",
    summary: runtime.hasNativeSummary ? "native:tts-summary" : "rule-only",
    scriptTts: runtime.hasScriptTts,
    scriptStt: runtime.hasScriptStt,
    ffprobe: runtime.hasFfprobe
  };

  return runtime;
}

function logRuntimeReadiness(runtime, logger) {
  if (!runtime || !logger?.info) return;
  logger.info(
    `[feishu-voice] runtime ready: nativeTts=${runtime.summary.tts}, nativeStt=${runtime.summary.stt}, summary=${runtime.summary.summary}, scriptTts=${runtime.summary.scriptTts}, scriptStt=${runtime.summary.scriptStt}, ffprobe=${runtime.summary.ffprobe}`
  );
}

module.exports = {
  createPluginRuntime,
  hasNativeSttRuntime,
  logRuntimeReadiness
};
