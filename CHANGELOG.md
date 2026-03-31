# 更新日志

## 2026.3.31

### 原生能力对齐重构

- 重构插件内部结构，拆分为运行时探测、会话路由、状态存储、回复分发、文本清洗、摘要处理等独立模块。
- 自动语音回复继续优先复用 OpenClaw 原生 `messages.tts` 链路。
- 长文本语音回复摘要调整为“原生摘要优先，规则摘要兜底”模式。
- 飞书入站语音转写现在优先调用 OpenClaw 原生 `api.runtime.stt.transcribeAudioFile(...)`。
- 原生 TTS / STT 不可用时，仍保留脚本兜底能力。
- 继续跳过 emoji、Markdown、代码块等不适合语音朗读的内容。
- 增加运行时能力探测日志，便于确认当前是否命中 native TTS / STT / summary。
- 修复发布清单，确保打包时包含 `lib/` 与相关运行文件。
- 补充 README 与回归测试，`npm test`、`npm run check` 均已通过。

### 早期更新

- 新增长文本语音摘要能力，避免超长回复被直接截断。
- 补充 `maxCapturedReplyChars` 与 `voiceReplySummary*` 相关配置项。
- 将项目内介绍性文档、注释和插件描述统一为中文。
- 补齐插件项目基础文件：`package.json`、`.gitignore`、`LICENSE`、`CHANGELOG.md`。
