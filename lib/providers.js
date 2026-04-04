"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveSpeechOptions } = require("./config");
const { transcribeAudioFileWithToolchain } = require("./toolchain");
const { normalizeSpeechText, normalizeText } = require("./text");
const { synthesizeVoiceAudio, synthesizeVoiceAudioWithNativeTts } = require("./audio");
const { createPluginRuntime } = require("./runtime");

function resolveRuntime(config, runtime) {
  return runtime || config?.runtime || createPluginRuntime(config);
}

function isNativeTtsAvailable(config, runtime) {
  return !!resolveRuntime(config, runtime)?.hasNativeTts;
}

function detectInputExtension(req) {
  const name = typeof req?.fileName === "string" ? req.fileName.trim() : "";
  const parsed = path.extname(name).toLowerCase();
  return parsed || ".ogg";
}

function detectAudioMime(req, ext) {
  if (typeof req?.mimeType === "string" && req.mimeType.trim()) {
    return req.mimeType.trim();
  }

  switch (ext) {
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    case ".ogg":
    case ".opus":
    default:
      return "audio/ogg";
  }
}

function readExecutionOutput(value) {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return String(value).trim();
  return "";
}

async function transcribeAudioWithNativeRuntime(config, runtime, req, logger = null) {
  if (!runtime?.hasNativeStt || typeof runtime.coreRuntime?.stt?.transcribeAudioFile !== "function") {
    return null;
  }
  if (!config?.gatewayConfig || !req?.buffer || !Buffer.isBuffer(req.buffer) || req.buffer.length === 0) {
    return null;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-native-stt-"));
  const ext = detectInputExtension(req);
  const inputPath = path.join(tmpRoot, `input${ext}`);

  try {
    fs.writeFileSync(inputPath, req.buffer);
    const result = await runtime.coreRuntime.stt.transcribeAudioFile({
      filePath: inputPath,
      cfg: config.gatewayConfig,
      mime: detectAudioMime(req, ext)
    });
    const text = normalizeText(result?.text || "");
    if (!text) {
      throw new Error("native stt transcript is empty");
    }
    return {
      text,
      model: result?.model || "openclaw:media-understanding"
    };
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      const detail = err && typeof err.message === "string" ? err.message : String(err);
      logger?.warn?.(`feishu-voice native stt temp cleanup failed: ${detail}`);
    }
  }
}

// Speech provider 面向 OpenClaw 的通用 TTS 能力，尽量只暴露平台无关接口。
function buildProvider(config, logger, runtime, deps = {}) {
  const pluginRuntime = resolveRuntime(config, runtime);
  const synthesizeVoiceAudioWithNativeTtsImpl = typeof deps.synthesizeVoiceAudioWithNativeTtsImpl === "function"
    ? deps.synthesizeVoiceAudioWithNativeTtsImpl
    : synthesizeVoiceAudioWithNativeTts;
  const synthesizeVoiceAudioImpl = typeof deps.synthesizeVoiceAudioImpl === "function"
    ? deps.synthesizeVoiceAudioImpl
    : synthesizeVoiceAudio;
  return {
    id: "feishu-voice",
    label: "Feishu Voice Skill",
    aliases: ["feishu-voice-chat", "feishu_voice"],
    voices: [
      "zh-CN-XiaoxiaoNeural",
      "zh-CN-YunxiNeural",
      "zh-CN-YunjianNeural",
      "zh-CN-XiaoyiNeural",
      "en-US-JennyNeural"
    ],
    isConfigured: () => pluginRuntime.hasNativeTts || pluginRuntime.hasToolTts,
    synthesize: async (req) => {
      const text = normalizeSpeechText(req?.overrides?.ttsText || req?.text, req?.config?.maxTextLength || config.maxReplyChars);
      const speechOptions = resolveSpeechOptions(config, req);
      let artifact = await synthesizeVoiceAudioWithNativeTtsImpl(config, logger, {
        text,
        ...speechOptions
      }, {
        runtime: pluginRuntime
      });
      if (!artifact) {
        artifact = synthesizeVoiceAudioImpl({
          ...config,
          runtime: pluginRuntime
        }, logger, {
          text,
          ...speechOptions
        });
      }
      return {
        audioBuffer: artifact.audioBuffer,
        outputFormat: artifact.fileType || "opus",
        fileExtension: path.extname(artifact.fileName || "") || ".opus",
        voiceCompatible: true
      };
    }
  };
}

// STT 保持单独 provider，避免和发送飞书语音的逻辑混在一起。
function buildMediaUnderstandingProvider(config, logger, runtime, deps = {}) {
  const pluginRuntime = resolveRuntime(config, runtime);
  const transcribeAudioFileWithToolchainImpl = typeof deps.transcribeAudioFileWithToolchainImpl === "function"
    ? deps.transcribeAudioFileWithToolchainImpl
    : transcribeAudioFileWithToolchain;
  return {
    id: "feishu-voice",
    capabilities: ["audio"],
    transcribeAudio: async (req) => {
      if (!req?.buffer || !Buffer.isBuffer(req.buffer) || req.buffer.length === 0) {
        throw new Error("empty audio buffer for transcription");
      }

      try {
        const nativeResult = await transcribeAudioWithNativeRuntime(config, pluginRuntime, req, logger);
        if (nativeResult) {
          logger?.info?.(`feishu-voice transcribed via OpenClaw runtime model=${nativeResult.model}`);
          return nativeResult;
        }
      } catch (err) {
        const detail = err && typeof err.message === "string" ? err.message : String(err);
        logger?.warn?.(`feishu-voice native stt failed, fallback to local toolchain: ${detail}`);
      }

      if (!pluginRuntime.hasToolStt) {
        throw new Error("feishu-voice transcribe unavailable: local toolchain not ready");
      }

      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-stt-"));
      const ext = detectInputExtension(req);
      const inputPath = path.join(tmpRoot, `input${ext}`);

      try {
        fs.writeFileSync(inputPath, req.buffer);
        const result = transcribeAudioFileWithToolchainImpl({
          inputPath,
          language: config.sttLanguage,
          model: config.sttModel
        });
        const text = normalizeText(result?.text || "");
        if (!text) {
          throw new Error("stt transcript is empty");
        }
        return {
          text,
          model: result?.model || `local-whisper:${config.sttModel}`
        };
      } catch (err) {
        const stderr = readExecutionOutput(err?.stderr);
        const stdout = readExecutionOutput(err?.stdout);
        const detail = stderr || stdout || (err && err.message) || String(err);
        if (process.env.NODE_ENV === "development" && detail) {
          logger?.warn?.(`feishu-voice transcribe failed: ${detail}`);
        } else {
          logger?.warn?.("feishu-voice transcribe failed");
        }
        throw new Error("feishu-voice transcribe failed");
      } finally {
        try {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch (cleanupErr) {
          const cleanupDetail = cleanupErr && typeof cleanupErr.message === "string" ? cleanupErr.message : String(cleanupErr);
          logger?.warn?.(`feishu-voice stt temp cleanup failed: ${cleanupDetail}`);
        }
      }
    }
  };
}

module.exports = {
  buildMediaUnderstandingProvider,
  buildProvider,
  isNativeTtsAvailable,
  transcribeAudioWithNativeRuntime
};
