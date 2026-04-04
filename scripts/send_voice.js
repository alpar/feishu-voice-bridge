"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { probeAudioDurationMs } = require("../lib/audio");
const { createAudioMessage, normalizeFeishuMessageId, resolveRequestedReceiveIdType } = require("../lib/feishu");
const { cleanupTempRoot, synthesizeSpeechToOpusFile } = require("../lib/toolchain");

function printHelp() {
  console.log(`🎤 Feishu voice chat - Node 调试语音发送脚本

用法：node scripts/send_voice.js [选项]

选项:
  -t, --text <text>       要转换的文字（必需）
  -v, --voice <voice>     音色名称（默认：zh-CN-XiaoxiaoNeural）
  -r, --rate <0>          语速（支持 10 / +10 / +10%，默认 0）
  -p, --pitch <0>         音调（支持 5 / +5Hz / +5%，默认 0）
  -o, --output <file>     输出音频文件路径
  -c, --chat-id <id>      指定 chat_id（覆盖 FEISHU_CHAT_ID）
  --receive-id-type <t>   指定接收方类型：chat_id / open_id / user_id
  --reply-to <message_id> 回复到指定消息（om_xxx）
  --list-voices           列出所有可用音色
  --no-send               只生成音频，不发送
  -h, --help              显示帮助

常用音色:
  zh-CN-XiaoxiaoNeural    女声，温暖亲切（推荐）
  zh-CN-YunxiNeural       男声，沉稳专业
  zh-CN-YunjianNeural     男声，激情澎湃
  zh-CN-XiaoyiNeural      女声，活泼可爱
  en-US-JennyNeural       女声，美式英语

示例:
  node scripts/send_voice.js -t "主人晚上好～"
  node scripts/send_voice.js -t "Hello!" -v en-US-JennyNeural
  node scripts/send_voice.js -t "你好" --rate 10 --pitch 5
  node scripts/send_voice.js -t "收到" --reply-to om_xxx
  node scripts/send_voice.js --list-voices`);
}

function parseArgs(argv) {
  const options = {
    text: "",
    voice: "zh-CN-XiaoxiaoNeural",
    rate: "0",
    pitch: "0",
    output: "",
    chatId: "",
    receiveIdType: "",
    replyTo: "",
    listVoices: false,
    noSend: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-t":
      case "--text":
        options.text = argv[index + 1] || "";
        index += 1;
        break;
      case "-v":
      case "--voice":
        options.voice = argv[index + 1] || "";
        index += 1;
        break;
      case "-r":
      case "--rate":
        options.rate = argv[index + 1] || "";
        index += 1;
        break;
      case "-p":
      case "--pitch":
        options.pitch = argv[index + 1] || "";
        index += 1;
        break;
      case "-o":
      case "--output":
        options.output = argv[index + 1] || "";
        index += 1;
        break;
      case "-c":
      case "--chat-id":
        options.chatId = argv[index + 1] || "";
        index += 1;
        break;
      case "--receive-id-type":
        options.receiveIdType = argv[index + 1] || "";
        index += 1;
        break;
      case "--reply-to":
        options.replyTo = argv[index + 1] || "";
        index += 1;
        break;
      case "--list-voices":
        options.listVoices = true;
        break;
      case "--no-send":
        options.noSend = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`未知选项：${arg}`);
    }
  }

  return options;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function resolveOpenClawJsonPath() {
  return process.env.OPENCLAW_JSON || path.join(process.env.HOME || "", ".openclaw", "openclaw.json");
}

function buildGatewayConfigFromEnv() {
  const configPath = resolveOpenClawJsonPath();
  const gatewayConfig = readJsonFile(configPath);
  const currentFeishu = gatewayConfig?.channels?.feishu && typeof gatewayConfig.channels.feishu === "object"
    ? gatewayConfig.channels.feishu
    : {};

  gatewayConfig.channels = gatewayConfig.channels && typeof gatewayConfig.channels === "object"
    ? gatewayConfig.channels
    : {};
  gatewayConfig.channels.feishu = {
    ...currentFeishu,
    ...(process.env.FEISHU_APP_ID ? { appId: process.env.FEISHU_APP_ID } : {}),
    ...(process.env.FEISHU_APP_SECRET ? { appSecret: process.env.FEISHU_APP_SECRET } : {}),
    ...(process.env.FEISHU_CHAT_ID ? { chatId: process.env.FEISHU_CHAT_ID } : {})
  };
  return gatewayConfig;
}

function createConsoleLogger() {
  return {
    info(message) {
      console.error(message);
    },
    warn(message) {
      console.error(message);
    },
    error(message) {
      console.error(message);
    }
  };
}

function listVoices() {
  const stdout = execFileSync("edge-tts", ["--list-voices"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000
  });
  const lines = String(stdout || "")
    .split(/\r?\n/gu)
    .filter((line) => /zh-CN|zh-HK|zh-TW|en-US|en-GB/u.test(line))
    .slice(0, 30);
  console.log("🎤 可用音色：");
  for (const line of lines) {
    console.log(line);
  }
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    printHelp();
    return 1;
  }

  if (options.help) {
    printHelp();
    return 0;
  }

  if (options.listVoices) {
    try {
      listVoices();
      return 0;
    } catch (err) {
      console.error(`❌ 获取音色列表失败：${err && err.message ? err.message : String(err)}`);
      return 1;
    }
  }

  if (!options.text.trim()) {
    console.error("❌ 错误：必须提供 -t 文字");
    printHelp();
    return 1;
  }

  const gatewayConfig = buildGatewayConfigFromEnv();
  const feishuConfig = gatewayConfig?.channels?.feishu && typeof gatewayConfig.channels.feishu === "object"
    ? gatewayConfig.channels.feishu
    : {};
  const chatId = options.chatId.trim() || String(feishuConfig.chatId || "").trim();
  const replyTo = normalizeFeishuMessageId(options.replyTo);
  const receiveIdType = resolveRequestedReceiveIdType(options.receiveIdType, chatId);

  if (!options.noSend && !String(feishuConfig.appId || "").trim()) {
    console.error("❌ 错误：缺少 Feishu appId，请设置 FEISHU_APP_ID 或在 openclaw.json 中配置 channels.feishu.appId");
    return 1;
  }
  if (!options.noSend && !String(feishuConfig.appSecret || "").trim()) {
    console.error("❌ 错误：缺少 Feishu appSecret，请设置 FEISHU_APP_SECRET 或在 openclaw.json 中配置 channels.feishu.appSecret");
    return 1;
  }
  if (!options.noSend && !replyTo && !chatId) {
    console.error("❌ 错误：缺少 chat_id（请设置 FEISHU_CHAT_ID 或传 --chat-id）");
    return 1;
  }

  let synthesis = null;
  try {
    console.error("🎤 开始生成语音...");
    console.error(`文字：${options.text}`);
    console.error(`音色：${options.voice}`);
    console.error(`语速：${options.rate || "0"}`);
    console.error(`音调：${options.pitch || "0"}`);
    console.error("");

    synthesis = synthesizeSpeechToOpusFile({
      text: options.text,
      voice: options.voice,
      rate: options.rate,
      pitch: options.pitch
    });

    const outputPath = synthesis.outputPath;
    const audioBuffer = fs.readFileSync(outputPath);
    const durationMs = probeAudioDurationMs(outputPath);

    if (options.output.trim()) {
      const targetPath = path.resolve(options.output.trim());
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(outputPath, targetPath);
      console.error(`✅ 已保存到：${targetPath}`);
    }

    if (options.noSend) {
      console.error("✅ 完成（未发送）");
      return 0;
    }

    const result = await createAudioMessage({
      gatewayConfig
    }, createConsoleLogger(), {
      chatId,
      receiveIdType,
      replyToMessageId: replyTo,
      audioBuffer,
      durationMs,
      fileType: "opus",
      fileName: "voice.opus",
      mimeType: "audio/ogg"
    });

    console.log("✅ 发送成功！");
    console.log(`Message ID: ${result.messageId || "unknown"}`);
    if (replyTo) {
      console.log(`Reply To: ${replyTo}`);
    } else {
      console.log(`Receive ID Type: ${receiveIdType}`);
      console.log(`Target ID: ${chatId}`);
    }
    console.log(`时长：${durationMs}ms`);
    return 0;
  } catch (err) {
    console.error(`❌ 错误：${err && err.message ? err.message : String(err)}`);
    return 1;
  } finally {
    cleanupTempRoot(synthesis?.tmpRoot);
  }
}

module.exports = {
  main,
  parseArgs
};

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
