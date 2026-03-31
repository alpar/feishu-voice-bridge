"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { SUPPORTED_TOOL_AUDIO_EXTENSIONS } = require("./constants");
const { normalizeSpeechText, normalizeText } = require("./text");
const {
  createAudioMessage,
  normalizeFeishuMessageId,
  normalizeFeishuTarget,
  resolveReceiveIdType
} = require("./feishu");

// 通过 ffprobe 读取真实时长，避免飞书侧把语音显示成 0 秒或异常时长。
function probeAudioDurationMs(filePath) {
  const stdout = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000
  });

  const seconds = Number(String(stdout || "").trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("invalid audio duration from ffprobe");
  }
  return Math.max(1, Math.round(seconds * 1000));
}

function buildAudioArtifact(params) {
  return {
    audioBuffer: params.audioBuffer,
    durationMs: params.durationMs,
    fileType: params.fileType || "opus",
    fileName: params.fileName || "reply.opus",
    mimeType: params.mimeType || "audio/ogg",
    source: params.source || "unknown",
    sourcePath: params.sourcePath || ""
  };
}

function loadGeneratedAudioArtifact(filePath, source) {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  const normalizedPath = filePath.trim();
  if (!fs.existsSync(normalizedPath)) return null;

  const extension = path.extname(normalizedPath).toLowerCase();
  if (!SUPPORTED_TOOL_AUDIO_EXTENSIONS.has(extension)) return null;

  const audioBuffer = fs.readFileSync(normalizedPath);
  if (!audioBuffer.length) return null;

  return buildAudioArtifact({
    audioBuffer,
    durationMs: probeAudioDurationMs(normalizedPath),
    fileType: "opus",
    fileName: `reply${extension || ".opus"}`,
    mimeType: "audio/ogg",
    source,
    sourcePath: normalizedPath
  });
}

// 如果上游 tts 工具已经产出了可复用音频，优先复用，避免重复合成。
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

// 本地脚本只负责“把文本变成音频文件”，这里补上临时目录、读取和错误包装。
function synthesizeVoiceAudio(config, logger, params) {
  if (!fs.existsSync(config.scriptPath)) {
    throw new Error(`feishu-voice script not found: ${config.scriptPath}`);
  }

  const text = normalizeText(params.text);
  if (!text) throw new Error("empty text for synthesis");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-tts-"));
  const outputPath = path.join(tmpRoot, "speech.opus");
  const args = [
    config.scriptPath,
    "-t",
    text,
    "--no-send",
    "-o",
    outputPath,
    "-v",
    params.voice,
    "-r",
    params.rate,
    "-p",
    params.pitch
  ];

  try {
    execFileSync("bash", args, {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000
    });

    if (!fs.existsSync(outputPath)) {
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
      fileName: "reply.opus",
      mimeType: "audio/ogg",
      source: "script"
    });
  } catch (err) {
    const stderr = err && typeof err.stderr === "string" ? err.stderr.trim() : "";
    const stdout = err && typeof err.stdout === "string" ? err.stdout.trim() : "";
    const detail = stderr || stdout || (err && err.message) || String(err);
    logger?.warn?.(`feishu-voice synthesize failed: ${detail}`);
    throw new Error(`feishu-voice synthesize failed: ${detail}`);
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // 忽略临时目录清理失败，避免影响主流程。
    }
  }
}

// 飞书语音回复最终总是落成“上传文件 + 发送 audio 消息”两步。
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

  const audioArtifact = params.audioArtifact || synthesizeVoiceAudio(config, logger, {
    text,
    voice: params.voice || config.defaultVoice,
    rate: params.rate || config.defaultRate,
    pitch: params.pitch || config.defaultPitch
  });

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
    accountId: params.accountId
  });
  logger?.info?.(`feishu-voice media sent (target=${target}, replyTo=${replyToMessageId || "none"}, messageId=${result.messageId || "unknown"}, source=${audioArtifact.source || "unknown"})`);
  return true;
}

module.exports = {
  buildAudioArtifact,
  extractToolGeneratedAudioArtifact,
  loadGeneratedAudioArtifact,
  probeAudioDurationMs,
  sendVoiceReply,
  synthesizeVoiceAudio
};
