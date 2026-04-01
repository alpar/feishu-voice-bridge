"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { resolveSpeechOptions } = require("./config");
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

async function transcribeAudioWithNativeRuntime(config, runtime, req) {
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
    } catch {
      // 忽略临时目录清理失败，避免影响主流程。
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
    isConfigured: () => pluginRuntime.hasNativeTts || pluginRuntime.hasScriptTts,
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
        artifact = synthesizeVoiceAudioImpl(config, logger, {
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
function buildMediaUnderstandingProvider(config, logger, runtime) {
  const pluginRuntime = resolveRuntime(config, runtime);
  return {
    id: "feishu-voice",
    capabilities: ["audio"],
    transcribeAudio: async (req) => {
      if (!req?.buffer || !Buffer.isBuffer(req.buffer) || req.buffer.length === 0) {
        throw new Error("empty audio buffer for transcription");
      }

      try {
        const nativeResult = await transcribeAudioWithNativeRuntime(config, pluginRuntime, req);
        if (nativeResult) {
          logger?.info?.(`feishu-voice transcribed via OpenClaw runtime model=${nativeResult.model}`);
          return nativeResult;
        }
      } catch (err) {
        const detail = err && typeof err.message === "string" ? err.message : String(err);
        logger?.warn?.(`feishu-voice native stt failed, fallback to script: ${detail}`);
      }

      if (!pluginRuntime.hasScriptStt) {
        throw new Error(`feishu-voice stt script not found: ${config.sttScriptPath}`);
      }

      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-stt-"));
      const ext = detectInputExtension(req);
      const inputPath = path.join(tmpRoot, `input${ext}`);

      try {
        fs.writeFileSync(inputPath, req.buffer);
        const stdout = execFileSync("bash", [config.sttScriptPath, inputPath], {
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 10 * 1024 * 1024,
          timeout: 120000,
          env: {
            ...process.env,
            OPENCLAW_STT_LANGUAGE: config.sttLanguage,
            OPENCLAW_STT_MODEL: config.sttModel
          }
        });
        const text = normalizeText(String(stdout || ""));
        if (!text) {
          throw new Error("stt transcript is empty");
        }
        return {
          text,
          model: `local-whisper:${config.sttModel}`
        };
      } catch (err) {
        const stderr = err && typeof err.stderr === "string" ? err.stderr.trim() : "";
        const stdout = err && typeof err.stdout === "string" ? err.stdout.trim() : "";
        const detail = stderr || stdout || (err && err.message) || String(err);
        logger?.warn?.(`feishu-voice transcribe failed: ${detail}`);
        throw new Error(`feishu-voice transcribe failed: ${detail}`);
      } finally {
        try {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
          // 忽略临时目录清理失败，避免影响主流程。
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
