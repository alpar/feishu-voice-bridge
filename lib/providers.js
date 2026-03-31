"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { resolveSpeechOptions } = require("./config");
const { normalizeSpeechText, normalizeText } = require("./text");
const { synthesizeVoiceAudio } = require("./audio");

// Speech provider 面向 OpenClaw 的通用 TTS 能力，尽量只暴露平台无关接口。
function buildProvider(config, logger) {
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
    isConfigured: () => fs.existsSync(config.scriptPath),
    synthesize: async (req) => {
      const text = normalizeSpeechText(req?.overrides?.ttsText || req?.text, req?.config?.maxTextLength || config.maxReplyChars);
      const artifact = synthesizeVoiceAudio(config, logger, {
        text,
        ...resolveSpeechOptions(config, req)
      });
      return {
        audioBuffer: artifact.audioBuffer,
        outputFormat: "opus",
        fileExtension: ".opus",
        voiceCompatible: true
      };
    }
  };
}

// STT 保持单独 provider，避免和发送飞书语音的逻辑混在一起。
function buildMediaUnderstandingProvider(config, logger) {
  return {
    id: "feishu-voice",
    capabilities: ["audio"],
    transcribeAudio: async (req) => {
      if (!fs.existsSync(config.sttScriptPath)) {
        throw new Error(`feishu-voice stt script not found: ${config.sttScriptPath}`);
      }
      if (!req?.buffer || !Buffer.isBuffer(req.buffer) || req.buffer.length === 0) {
        throw new Error("empty audio buffer for transcription");
      }

      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-stt-"));
      const ext = (() => {
        const name = typeof req.fileName === "string" ? req.fileName.trim() : "";
        const parsed = path.extname(name);
        return parsed || ".ogg";
      })();
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
  buildProvider
};
