"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { SUPPORTED_TOOL_AUDIO_EXTENSIONS } = require("./constants");
const { synthesizeWithOpenClawTts } = require("./openclaw-tts-summary");
const { cleanupTempRoot, synthesizeSpeechToOpusFile } = require("./toolchain");
const { normalizeSpeechText, normalizeText } = require("./text");
const {
  createAudioMessage,
  normalizeFeishuMessageId,
  normalizeFeishuTarget,
  resolveReceiveIdType
} = require("./feishu");

const AUDIO_FILE_TYPE_BY_EXTENSION = {
  ".m4a": "m4a",
  ".mp3": "mp3",
  ".ogg": "ogg",
  ".opus": "opus",
  ".wav": "wav"
};

const AUDIO_MIME_TYPE_BY_EXTENSION = {
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav"
};

function probeAudioMetadata(filePath) {
  const stdout = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_name",
    "-of",
    "json",
    filePath
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000
  });

  const payload = JSON.parse(String(stdout || "{}"));
  const seconds = Number(payload?.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("invalid audio duration from ffprobe");
  }
  const codecName = Array.isArray(payload?.streams)
    ? payload.streams.map((stream) => String(stream?.codec_name || "").trim().toLowerCase()).find(Boolean) || ""
    : "";

  return {
    durationMs: Math.max(1, Math.round(seconds * 1000)),
    codecName
  };
}

// 用 ffprobe 读取真实时长，避免飞书显示 0 秒。
function probeAudioDurationMs(filePath) {
  return probeAudioMetadata(filePath).durationMs;
}

function buildAudioArtifact(params) {
  return {
    audioBuffer: params.audioBuffer,
    durationMs: params.durationMs,
    fileType: params.fileType || "opus",
    fileName: params.fileName || "voice.opus",
    mimeType: params.mimeType || "audio/ogg",
    source: params.source || "unknown",
    sourcePath: params.sourcePath || ""
  };
}

function logCleanupFailure(logger, label, err) {
  const detail = err && typeof err.message === "string" ? err.message : String(err);
  logger?.warn?.(`feishu-voice ${label} cleanup failed: ${detail}`);
}

function shouldExposeOperationalDetail() {
  return process.env.NODE_ENV === "development";
}

function readExecutionOutput(value) {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return String(value).trim();
  return "";
}

function throwRedactedExecutionError(prefix, logger, err) {
  const stderr = readExecutionOutput(err?.stderr);
  const stdout = readExecutionOutput(err?.stdout);
  const detail = stderr || stdout || (err && err.message) || String(err);
  if (shouldExposeOperationalDetail() && detail) {
    logger?.warn?.(`${prefix}: ${detail}`);
  } else {
    logger?.warn?.(prefix);
  }
  throw new Error(prefix);
}

function transcodeAudioToCanonicalOpus(inputPath, source, logger = null) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-normalize-"));
  const outputPath = path.join(tmpRoot, "voice.opus");

  try {
    execFileSync("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      outputPath
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000
    });

    const audioBuffer = fs.readFileSync(outputPath);
    if (!audioBuffer.length) {
      throw new Error("normalized opus audio is empty");
    }

    return buildAudioArtifact({
      audioBuffer,
      durationMs: probeAudioDurationMs(outputPath),
      fileType: "opus",
      fileName: "voice.opus",
      mimeType: "audio/ogg",
      source,
      sourcePath: inputPath
    });
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      logCleanupFailure(logger, "audio normalize temp", err);
    }
  }
}

function resolveAudioFileType(extension, codecName) {
  if (codecName === "opus") return "opus";
  return AUDIO_FILE_TYPE_BY_EXTENSION[extension] || extension.replace(/^\./u, "") || "opus";
}

function createTempAudioArtifactFromBuffer(audioBuffer, fileExtension, source, logger = null) {
  const normalizedExtension = typeof fileExtension === "string" && fileExtension.trim()
    ? (fileExtension.startsWith(".") ? fileExtension.trim().toLowerCase() : `.${fileExtension.trim().toLowerCase()}`)
    : ".opus";
  if (!SUPPORTED_TOOL_AUDIO_EXTENSIONS.has(normalizedExtension)) {
    return null;
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-native-tts-"));
  const outputPath = path.join(tmpRoot, `speech${normalizedExtension}`);

  try {
    fs.writeFileSync(outputPath, audioBuffer);
    return buildAudioArtifact({
      audioBuffer,
      durationMs: probeAudioDurationMs(outputPath),
      fileType: AUDIO_FILE_TYPE_BY_EXTENSION[normalizedExtension] || normalizedExtension.replace(/^\./u, "") || "opus",
      fileName: `reply${normalizedExtension}`,
      mimeType: AUDIO_MIME_TYPE_BY_EXTENSION[normalizedExtension] || "application/octet-stream",
      source
    });
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      logCleanupFailure(logger, "native tts temp", err);
    }
  }
}

function loadGeneratedAudioArtifact(filePath, source) {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  const normalizedPath = filePath.trim();
  if (!fs.existsSync(normalizedPath)) return null;

  const extension = path.extname(normalizedPath).toLowerCase();
  if (!SUPPORTED_TOOL_AUDIO_EXTENSIONS.has(extension)) return null;

  const audioBuffer = fs.readFileSync(normalizedPath);
  if (!audioBuffer.length) return null;
  const metadata = probeAudioMetadata(normalizedPath);

  // ogg/opus 统一转回稳定的 canonical opus，避免飞书丢失时长。
  if (extension === ".ogg" || extension === ".opus" || metadata.codecName === "opus") {
    return transcodeAudioToCanonicalOpus(normalizedPath, source);
  }

  return buildAudioArtifact({
    audioBuffer,
    durationMs: metadata.durationMs,
    fileType: resolveAudioFileType(extension, metadata.codecName),
    fileName: `reply${extension || ".opus"}`,
    mimeType: AUDIO_MIME_TYPE_BY_EXTENSION[extension] || "audio/ogg",
    source,
    sourcePath: normalizedPath
  });
}

// 能复用上游工具音频时就直接复用。
function extractToolGeneratedAudioArtifact(result, logger) {
  const candidates = [
    result?.details?.audioPath,
    result?.audioPath,
    result?.details?.media?.mediaUrl,
    result?.media?.mediaUrl
  ];

  for (const candidate of candidates) {
    try {
      const artifact = loadGeneratedAudioArtifact(candidate, "tts-tool");
      if (!artifact) continue;
      logger?.info?.(`feishu-voice captured generated audio (${artifact.sourcePath})`);
      return artifact;
    } catch (err) {
      const detail = err && typeof err.message === "string" ? err.message : String(err);
      logger?.warn?.(`feishu-voice ignored generated audio artifact: ${detail}`);
    }
  }
  return null;
}

async function synthesizeVoiceAudioWithNativeTts(config, logger, params, deps = {}) {
  if (!config.gatewayConfig) return null;

  const synthesis = await synthesizeWithOpenClawTts({
    text: params.text,
    cfg: config.gatewayConfig,
    channel: "feishu",
    overrides: {
      voice: params.voice,
      rate: params.rate,
      pitch: params.pitch
    },
    loadSpeechRuntime: deps.runtime?.speechRuntime
      ? () => deps.runtime.speechRuntime
      : undefined
  });
  if (!synthesis?.audioBuffer?.length) {
    return null;
  }

  const artifact = createTempAudioArtifactFromBuffer(
    synthesis.audioBuffer,
    synthesis.fileExtension || ".opus",
    `openclaw:${synthesis.provider || "tts"}`,
    logger
  );
  if (!artifact) {
    logger?.info?.(`feishu-voice skip unsupported native TTS format=${synthesis.fileExtension || "unknown"}, fallback to local toolchain synthesis`);
    return null;
  }
  logger?.info?.(`feishu-voice synthesized via OpenClaw TTS provider=${synthesis.provider || "unknown"} format=${synthesis.outputFormat || "unknown"}`);
  return artifact;
}

// 本地工具链统一由 Node 进程拉起，不再让 bash 进入插件主链路。
function synthesizeVoiceAudio(config, logger, params, deps = {}) {
  if (config?.runtime?.hasToolTts === false) {
    throw new Error("feishu-voice synthesize unavailable: local toolchain not ready");
  }

  const synthesizeSpeechToOpusFileImpl = typeof deps.synthesizeSpeechToOpusFileImpl === "function"
    ? deps.synthesizeSpeechToOpusFileImpl
    : synthesizeSpeechToOpusFile;
  const text = normalizeText(params.text);
  if (!text) throw new Error("empty text for synthesis");
  let synthesis = null;

  try {
    synthesis = synthesizeSpeechToOpusFileImpl({
      text,
      voice: params.voice,
      rate: params.rate,
      pitch: params.pitch
    });

    const outputPath = synthesis?.outputPath;
    if (!outputPath || !fs.existsSync(outputPath)) {
      throw new Error("voice reply audio was not generated");
    }

    const audioBuffer = fs.readFileSync(outputPath);
    if (!audioBuffer.length) {
      throw new Error("voice reply audio is empty");
    }

    return buildAudioArtifact({
      audioBuffer,
      durationMs: probeAudioDurationMs(outputPath),
      fileType: "opus",
      fileName: "voice.opus",
      mimeType: "audio/ogg",
      source: "toolchain"
    });
  } catch (err) {
    throwRedactedExecutionError("feishu-voice synthesize failed", logger, err);
  } finally {
    try {
      cleanupTempRoot(synthesis?.tmpRoot);
    } catch (err) {
      logCleanupFailure(logger, "tts temp", err);
    }
  }
}

// 飞书语音发送固定走“上传文件 + 发送 audio”两步。
async function sendVoiceReply(config, logger, params) {
  const text = normalizeSpeechText(params.text, config.maxReplyChars);
  if (!text) return false;

  const replyToMessageId = normalizeFeishuMessageId(params.replyToMessageId);
  const target = normalizeFeishuTarget(params.chatId);
  const receiveIdType = target ? resolveReceiveIdType(target) : "";
  if (!replyToMessageId && (!target || !receiveIdType)) {
    logger?.warn?.(`voice reply skipped: unresolved feishu target (${params.chatId || "empty"})`);
    return false;
  }
  if (!config.gatewayConfig) {
    throw new Error("gateway config unavailable for Feishu upload");
  }

  let audioArtifact = params.audioArtifact || null;
  if (!audioArtifact) {
    audioArtifact = await synthesizeVoiceAudioWithNativeTts(config, logger, {
      text,
      voice: params.voice || config.defaultVoice,
      rate: params.rate || config.defaultRate,
      pitch: params.pitch || config.defaultPitch
    }, {
      runtime: config.runtime
    });
  }
  if (!audioArtifact) {
    audioArtifact = synthesizeVoiceAudio(config, logger, {
      text,
      voice: params.voice || config.defaultVoice,
      rate: params.rate || config.defaultRate,
      pitch: params.pitch || config.defaultPitch
    });
  }

  if (!audioArtifact?.audioBuffer?.length) {
    throw new Error("voice reply audio artifact is empty");
  }

  if (replyToMessageId) {
    logger?.info?.(`feishu-voice sending standalone audio to target=${target} (replyTo=${replyToMessageId} kept for trace only)`);
  }

  const result = await createAudioMessage(config, logger, {
    chatId: target,
    audioBuffer: audioArtifact.audioBuffer,
    durationMs: audioArtifact.durationMs,
    fileType: audioArtifact.fileType,
    fileName: audioArtifact.fileName,
    mimeType: audioArtifact.mimeType,
    replyToMessageId,
    accountId: params.accountId
  });
  logger?.info?.(`feishu-voice media sent (target=${target}, replyTo=${replyToMessageId || "none"}, messageId=${result.messageId || "unknown"}, source=${audioArtifact.source || "unknown"})`);
  return true;
}

module.exports = {
  buildAudioArtifact,
  createTempAudioArtifactFromBuffer,
  extractToolGeneratedAudioArtifact,
  loadGeneratedAudioArtifact,
  probeAudioMetadata,
  probeAudioDurationMs,
  sendVoiceReply,
  synthesizeVoiceAudioWithNativeTts,
  synthesizeVoiceAudio,
  throwRedactedExecutionError
};
