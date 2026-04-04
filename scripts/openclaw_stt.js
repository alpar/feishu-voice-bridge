"use strict";

const { runVoiceToTextCli } = require("./voice_to_text");

async function main(argv = process.argv.slice(2)) {
  const inputPath = argv[0] || "";
  if (!inputPath.trim()) {
    console.error("缺少输入音频路径");
    return 1;
  }

  const forwardedArgs = [
    "-i",
    inputPath,
    "-l",
    process.env.OPENCLAW_STT_LANGUAGE || "zh-CN",
    "-m",
    process.env.OPENCLAW_STT_MODEL || "small",
    "--openclaw-stdout-only"
  ];

  return runVoiceToTextCli(forwardedArgs);
}

module.exports = {
  main
};

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
