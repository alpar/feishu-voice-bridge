"use strict";

const path = require("node:path");

const ROOT_DIR = path.join(__dirname, "..");

// 所有默认值集中放在这里，避免魔法值散落在各个模块中。
module.exports = {
  DEFAULT_SCRIPT_PATH: path.join(ROOT_DIR, "scripts", "send_voice.sh"),
  DEFAULT_STT_SCRIPT_PATH: path.join(ROOT_DIR, "scripts", "openclaw_stt.sh"),
  DEFAULT_VOICE: "zh-CN-XiaoxiaoNeural",
  DEFAULT_RATE: "+20",
  DEFAULT_PITCH: "0",
  DEFAULT_STT_LANGUAGE: "zh-CN",
  DEFAULT_STT_MODEL: "small",
  DEFAULT_VOICE_REPLY_ENABLED: false,
  DEFAULT_VOICE_REPLY_MODE: "inbound",
  DEFAULT_VOICE_REPLY_WINDOW_MS: 20 * 60 * 1000,
  DEFAULT_VOICE_REPLY_COOLDOWN_MS: 30 * 1000,
  DEFAULT_MAX_REPLY_CHARS: 280,
  DEFAULT_VOICE_REPLY_DEBOUNCE_MS: 2500,
  DEFAULT_PROMPT_TOOL_TTS_FOR_TEXT: false,
  DEFAULT_VOICE_REPLY_SUMMARY_ENABLED: true,
  DEFAULT_VOICE_REPLY_SUMMARY_MAX_SENTENCES: 3,
  DEFAULT_VOICE_REPLY_SUMMARY_JOINER: "；",
  DEFAULT_VOICE_REPLY_SUMMARY_PREFIX: "语音摘要：",
  DEFAULT_VOICE_REPLY_SUMMARY_SUFFIX: "（完整内容请查看文字回复）",
  DEFAULT_MAX_CAPTURED_REPLY_CHARS: 6000,
  RUN_FLUSH_TIMEOUT_MS: 45000,
  SUPPORTED_TOOL_AUDIO_EXTENSIONS: new Set([".m4a", ".mp3", ".ogg", ".opus", ".wav"]),
  FEISHU_TEXT_TTS_PROMPT: [
    "Feishu voice reply bridge is active for this conversation.",
    "If you call the `tts` tool, call it exactly once with the same final reply text so the channel can reuse that audio.",
    "Still send the normal final text reply to the user. Never replace the final text answer with `NO_REPLY` just because audio is enabled.",
    "Do not mention the tool call. Keep the spoken text and final text consistent. Skip the `tts` tool only if the user explicitly asks for text-only or no audio reply."
  ].join("\n"),
  SPEECH_EMOJI_REGEX: /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|[\p{Extended_Pictographic}\p{Emoji_Presentation}](?:\p{Emoji_Modifier}|\uFE0F|\u200D[\p{Extended_Pictographic}\p{Emoji_Presentation}](?:\p{Emoji_Modifier}|\uFE0F)?)*)/gu
};
