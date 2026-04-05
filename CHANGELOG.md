# 更新日志

## 2026.4.4

### Node 工具链统一

- 插件主流程统一为“OpenClaw 原生 runtime 优先，Node 工具链兜底”，不再让 Bash 脚本参与运行链路。
- 新增 `lib/toolchain.js`，统一由 Node 调用 `edge-tts`、`ffmpeg`、`whisper`。
- 运行时探测日志改为只输出 `toolTts` / `toolStt`，移除旧的脚本链路状态字段。
- 删除插件配置中的 `scriptPath` / `sttScriptPath`，同步收口 `openclaw.plugin.json` 与配置解析逻辑。
- 将仓库内调试脚本从 `scripts/*.sh` 迁移为 `scripts/*.js`，彻底去掉仓库内的 Bash 依赖。
- 更新 README、贡献说明与回归测试，`npm run check`、`npm test` 均已通过。

### 兼容性与稳定性补充

- 修复 Windows 下命令探测仍使用 `which` 的问题，改为按平台自动选择 `where.exe` / `which`，避免误判 `ffmpeg`、`ffprobe`、`edge-tts`、`whisper` 缺失。
- 调整调试脚本的默认配置路径解析，统一改为基于 Node `os.homedir()`，避免 Windows 环境下依赖 `HOME` 变量。
- 为 `voice_to_text.js` 补充输出目录自动创建，减少跨平台调试时因目标目录不存在导致的失败。
- 补充 README 中的 Windows 安装、自检、调试命令，以及旧版 `tools.media.audio.models` 从 `.sh` 迁移到 `.js` 的升级说明。
- 修复插件在 `register()` 阶段就主动加载 OpenClaw speech runtime 导致的递归/自引用问题，改为懒加载并增加重入保护，避免 `RangeError: Maximum call stack size exceeded` 和重复 `runtime ready` 日志。
- 为注册期懒加载和跨平台命令探测补充回归测试，确保原生 TTS / 摘要能力只在实际需要时再探测。

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
