"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { transcribeAudioFileWithToolchain } = require("../lib/toolchain");

const SUPPORTED_LANGUAGES = [
  "Chinese (中文)",
  "English (英语)",
  "Japanese (日语)",
  "Korean (韩语)",
  "French (法语)",
  "German (德语)",
  "Spanish (西班牙语)"
];

function printHelp() {
  console.log(`🎤 Feishu voice chat - 语音转文本功能

用法：node scripts/voice_to_text.js [选项]

选项:
  -i, --input <file>       输入音频文件（支持 .ogg, .mp3, .wav 等）
  -l, --language <lang>    语言（默认：Chinese）
  -m, --model <model>      Whisper 模型（默认：small，可选：tiny/base/small/medium/large）
  -o, --output <file>      输出文本文件路径
  --list-languages         列出支持的语言
  --openclaw-stdout-only   仅向 stdout 输出转写结果
  -h, --help               显示帮助

支持的语言:
  ${SUPPORTED_LANGUAGES.join("\n  ")}

示例:
  node scripts/voice_to_text.js -i voice.ogg
  node scripts/voice_to_text.js -i voice.ogg -l English
  node scripts/voice_to_text.js -i voice.ogg -m small
  node scripts/voice_to_text.js -i voice.ogg -o result.txt
  node scripts/voice_to_text.js --list-languages`);
}

function parseArgs(argv) {
  const options = {
    input: "",
    language: "Chinese",
    model: process.env.WHISPER_MODEL || "small",
    output: "",
    listLanguages: false,
    stdoutOnly: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-i":
      case "--input":
        options.input = argv[index + 1] || "";
        index += 1;
        break;
      case "-l":
      case "--language":
        options.language = argv[index + 1] || "";
        index += 1;
        break;
      case "-m":
      case "--model":
        options.model = argv[index + 1] || "";
        index += 1;
        break;
      case "-o":
      case "--output":
        options.output = argv[index + 1] || "";
        index += 1;
        break;
      case "--list-languages":
        options.listLanguages = true;
        break;
      case "--openclaw-stdout-only":
        options.stdoutOnly = true;
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

async function runVoiceToTextCli(argv = process.argv.slice(2)) {
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

  if (options.listLanguages) {
    console.log("🌍 支持的语言列表：");
    for (const language of SUPPORTED_LANGUAGES) {
      console.log(language);
    }
    console.log("\n更多语言请参考 whisper 文档");
    return 0;
  }

  const inputPath = options.input.trim();
  if (!inputPath) {
    console.error("❌ 错误：必须提供 -i 输入文件");
    printHelp();
    return 1;
  }
  if (!fs.existsSync(inputPath)) {
    console.error("❌ 错误：输入文件不存在");
    return 1;
  }

  try {
    if (!options.stdoutOnly) {
      console.error("🎤 开始语音转文字...");
      console.error(`输入文件：${inputPath}`);
      console.error(`语言：${options.language || "Chinese"}`);
      console.error("");
    }

    const result = transcribeAudioFileWithToolchain({
      inputPath,
      language: options.language,
      model: options.model
    });

    if (options.output.trim()) {
      const outputPath = path.resolve(options.output.trim());
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${result.text}\n`, "utf8");
      if (!options.stdoutOnly) {
        console.error(`✅ 文本已保存到：${outputPath}`);
      }
    }

    if (options.stdoutOnly) {
      process.stdout.write(`${result.text}\n`);
    } else {
      console.error("📝 转换结果：");
      console.error(result.text);
      console.error("✅ 语音转文字完成");
    }
    return 0;
  } catch (err) {
    console.error(`❌ 错误：${err && err.message ? err.message : String(err)}`);
    return 1;
  }
}

module.exports = {
  SUPPORTED_LANGUAGES,
  parseArgs,
  runVoiceToTextCli
};

if (require.main === module) {
  runVoiceToTextCli().then((code) => {
    process.exitCode = code;
  });
}
