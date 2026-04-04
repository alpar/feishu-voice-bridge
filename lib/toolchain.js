"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DEFAULT_WHISPER_MODEL_DIR = path.join(os.homedir(), ".openclaw", "tmp", "whisper-models");
const DEFAULT_WHISPER_BEAM_SIZE = "5";
const DEFAULT_WHISPER_BEST_OF = "5";

function execTool(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000,
    ...options
  });
}

function cleanupTempRoot(tmpRoot) {
  if (typeof tmpRoot !== "string" || !tmpRoot.trim()) return;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function formatEdgeRateValue(rawValue) {
  const value = typeof rawValue === "string" && rawValue.trim() ? rawValue.trim() : "0";
  if (/%$/u.test(value)) return /^[+-]/u.test(value) || value === "0%" ? value : `+${value}`;
  if (/^[+-]/u.test(value)) return `${value}%`;
  return `+${value}%`;
}

function formatEdgePitchValue(rawValue) {
  const value = typeof rawValue === "string" && rawValue.trim() ? rawValue.trim() : "0";
  if (/(hz|%)$/iu.test(value)) return /^[+-]/u.test(value) || value === "0Hz" || value === "0%" ? value : `+${value}`;
  if (/^[+-]/u.test(value)) return `${value}Hz`;
  return `+${value}Hz`;
}

function normalizeWhisperLanguage(rawLanguage) {
  const value = typeof rawLanguage === "string" && rawLanguage.trim() ? rawLanguage.trim().toLowerCase() : "zh-cn";
  switch (value) {
    case "chinese":
    case "中文":
    case "zh":
    case "zh-cn":
    case "zh_cn":
      return {
        code: "zh",
        initialPrompt: "以下是普通话中文语音转写。"
      };
    case "english":
    case "英文":
    case "en":
    case "en-us":
    case "en_us":
      return { code: "en", initialPrompt: "" };
    case "japanese":
    case "日语":
    case "ja":
    case "ja-jp":
    case "ja_jp":
      return { code: "ja", initialPrompt: "" };
    case "korean":
    case "韩语":
    case "ko":
    case "ko-kr":
    case "ko_kr":
      return { code: "ko", initialPrompt: "" };
    default:
      return { code: value, initialPrompt: "" };
  }
}

function synthesizeSpeechToOpusFile(params) {
  const text = typeof params?.text === "string" ? params.text.trim() : "";
  if (!text) {
    throw new Error("empty text for synthesis");
  }

  const voice = typeof params?.voice === "string" && params.voice.trim()
    ? params.voice.trim()
    : "zh-CN-XiaoxiaoNeural";
  const rate = formatEdgeRateValue(params?.rate);
  const pitch = formatEdgePitchValue(params?.pitch);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-tool-tts-"));
  const edgeOutputPath = path.join(tmpRoot, "speech.mp3");
  const opusOutputPath = path.join(tmpRoot, "speech.opus");

  execTool("edge-tts", [
    "--text",
    text,
    "--voice",
    voice,
    "--rate",
    rate,
    "--pitch",
    pitch,
    "--write-media",
    edgeOutputPath
  ]);

  if (!fs.existsSync(edgeOutputPath)) {
    throw new Error("edge-tts output is missing");
  }

  execTool("ffmpeg", [
    "-y",
    "-i",
    edgeOutputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-c:a",
    "libopus",
    "-b:a",
    "32k",
    opusOutputPath
  ]);

  if (!fs.existsSync(opusOutputPath)) {
    throw new Error("ffmpeg opus output is missing");
  }

  return {
    tmpRoot,
    outputPath: opusOutputPath
  };
}

function transcribeAudioFileWithToolchain(params) {
  const inputPath = typeof params?.inputPath === "string" ? params.inputPath.trim() : "";
  if (!inputPath) {
    throw new Error("missing input audio path");
  }

  const model = typeof params?.model === "string" && params.model.trim() ? params.model.trim() : "small";
  const whisperModelDir = typeof process.env.WHISPER_MODEL_DIR === "string" && process.env.WHISPER_MODEL_DIR.trim()
    ? process.env.WHISPER_MODEL_DIR.trim()
    : DEFAULT_WHISPER_MODEL_DIR;
  const beamSize = typeof process.env.WHISPER_BEAM_SIZE === "string" && process.env.WHISPER_BEAM_SIZE.trim()
    ? process.env.WHISPER_BEAM_SIZE.trim()
    : DEFAULT_WHISPER_BEAM_SIZE;
  const bestOf = typeof process.env.WHISPER_BEST_OF === "string" && process.env.WHISPER_BEST_OF.trim()
    ? process.env.WHISPER_BEST_OF.trim()
    : DEFAULT_WHISPER_BEST_OF;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-voice-tool-stt-"));
  const normalizedAudioPath = path.join(tmpRoot, "input.wav");
  const { code: languageCode, initialPrompt } = normalizeWhisperLanguage(params?.language);
  let whisperInputPath = inputPath;

  fs.mkdirSync(whisperModelDir, { recursive: true });

  try {
    try {
      execTool("ffmpeg", [
        "-y",
        "-i",
        inputPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-af",
        "highpass=f=80,lowpass=f=7600,volume=1.8",
        normalizedAudioPath
      ]);
      whisperInputPath = normalizedAudioPath;
    } catch {
      whisperInputPath = inputPath;
    }

    const whisperArgs = [
      whisperInputPath,
      "--language",
      languageCode,
      "--model",
      model,
      "--model_dir",
      whisperModelDir,
      "--beam_size",
      beamSize,
      "--best_of",
      bestOf,
      "--temperature",
      "0",
      "--fp16",
      "False",
      "--output_format",
      "txt",
      "--output_dir",
      tmpRoot
    ];
    if (initialPrompt) {
      whisperArgs.push("--initial_prompt", initialPrompt);
    }

    execTool("whisper", whisperArgs);

    const outputPath = path.join(tmpRoot, `${path.parse(whisperInputPath).name}.txt`);
    if (!fs.existsSync(outputPath)) {
      throw new Error("whisper output is missing");
    }

    const text = String(fs.readFileSync(outputPath, "utf8") || "")
      .replace(/\r?\n+/gu, " ")
      .trim();
    if (!text) {
      throw new Error("stt transcript is empty");
    }

    return {
      text,
      model: `local-whisper:${model}`
    };
  } finally {
    cleanupTempRoot(tmpRoot);
  }
}

module.exports = {
  cleanupTempRoot,
  synthesizeSpeechToOpusFile,
  transcribeAudioFileWithToolchain
};
