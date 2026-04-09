# 飞书语音桥接插件

`feishu-voice-bridge` 是一个 OpenClaw 原生插件，用于：

1. 注册 `feishu-voice` TTS provider
2. 注册飞书语音转写 provider
3. 在飞书场景把最终文本回复补发为语音消息

## 当前版本

- 当前版本：`2026.4.6`
- 本版重点：自动语音回复状态模型已按 OpenClaw 最新宿主语义收敛，重点修复同一飞书会话中的跨轮串音问题。

## 2026.4.6 升级说明

- 自动语音回复现在以“当前 session 的当前 run”为中心做归属判断。
- `agent_end.messages` 是最终语音正文的主来源，`before_message_write` 负责缓存候选文本。
- `message_sent` 现在只作为“文本已发出”的观测信号，不再决定最终语音正文。
- 如果你之前遇到“上一轮学习汇报摘要被播成下一轮清理 evomap 的语音”这类问题，升级后请优先复测同一 DM 会话连续多轮场景。
- 升级后建议重启 OpenClaw Gateway，再执行一轮真实飞书会话回归。

## 快速安装

当前只支持源码安装。普通使用场景按下面这条默认流程走，不要混用 npm 包安装、`install -l` 或手动复制。

插件运行主流程在所有平台统一走 Node 工具链：

- TTS：`edge-tts` + `ffmpeg`
- STT：`whisper` + `ffmpeg`
- 仓库内调试脚本也统一为 Node 版本，不再依赖 Bash

### 1）放到默认扩展目录

```bash
git clone git@github.com:alpar/feishu-voice-bridge.git ~/.openclaw/extensions/feishu-voice-bridge
cd ~/.openclaw/extensions/feishu-voice-bridge
```

### 2）安装依赖

```bash
# 系统依赖
yum install -y ffmpeg       # CentOS / OpenCloudOS
apt-get install -y ffmpeg   # Ubuntu / Debian
brew install ffmpeg         # macOS

# Python 依赖
python3 -m pip install edge-tts
python3 -m pip install openai-whisper
```

Windows 参考：

- 先安装 Node.js 20+
- 用 `winget install Gyan.FFmpeg` 或其他方式安装 `ffmpeg` / `ffprobe`
- 确认 Python 和 `pip` 可用
- 执行 `py -m pip install edge-tts openai-whisper`
- 安装完成后重新打开 PowerShell，确保 `ffmpeg`、`ffprobe`、`edge-tts`、`whisper` 都在 `PATH` 中

### 3）安装插件

```bash
openclaw plugins install ~/.openclaw/extensions/feishu-voice-bridge
```

不要使用下面这些方式：

- `openclaw plugins install feishu-voice-bridge`
- 任何 npm registry / tgz 包安装方式
- `--dangerously-force-unsafe-install`

### 4）写入最小配置

OpenClaw 配置文件通常位于：

```bash
~/.openclaw/openclaw.json
```

Windows 常见路径：

```powershell
$HOME\.openclaw\openclaw.json
```

最小可运行配置：

```json5
{
  messages: {
    tts: false
  },
  plugins: {
    entries: {
      "feishu-voice-bridge": {
        enabled: true,
        config: {
          voiceReplyEnabled: true,
          voiceReplyMode: "inbound",
          voiceReplyWindowMs: 1200000,
          voiceReplyCooldownMs: 30000,
          voiceReplyDebounceMs: 2500,
          voiceReplyRetryCount: 2,
          voiceReplyRetryBackoffMs: 5000,
          maxReplyChars: 280,
          maxCapturedReplyChars: 6000,
          voiceReplySummaryEnabled: true,
          voiceReplySummaryMaxSentences: 3
        }
      }
    }
  }
}
```

说明：

- `channels.feishu.appId` / `channels.feishu.appSecret` 必填
- `messages.tts: false` 推荐配置，插件会使用自己的 Node 工具链完成语音合成
- 超长文本走插件内置摘要逻辑

### 5）重启 OpenClaw

```bash
openclaw gateway restart
```

如果是从旧版本升级，且你曾在 `openclaw.json` 里手工配置过：

```json5
tools.media.audio.models
```

请确认里面已经不再指向旧的 Bash 脚本，而是改成 Node 版本：

```json5
{
  tools: {
    media: {
      audio: {
        models: [
          {
            type: "cli",
            command: "node",
            args: [
              "/path/to/feishu-voice-bridge/scripts/openclaw_stt.js",
              "{{MediaPath}}"
            ],
            timeoutSeconds: 20
          }
        ]
      }
    }
  }
}
```

旧配置如果仍然是：

```json5
command: "bash"
args: ["/path/to/scripts/openclaw_stt.sh", "{{MediaPath}}"]
```

升级后会直接导致 STT 链路失效。

### 6）验证

```bash
cd ~/.openclaw/extensions/feishu-voice-bridge
npm run check
npm test
openclaw plugins info feishu-voice-bridge
```

确认：

- 插件状态为已加载
- `speech` 中有 `feishu-voice`
- `media-understanding` 中有 `feishu-voice`

### 7）验证功能

建议按顺序测试：

1. 发一条飞书语音给机器人
2. 确认能转写并正常回文本
3. 确认插件额外补发了一条飞书语音
4. 发一条超长问题，确认语音读的是摘要
5. 发一条包含 emoji 的文本，确认语音会跳过 emoji

`voiceReplyMode: "inbound"` 下，自动语音回复只会在最近一次飞书入站消息后的窗口内触发。

---
---

## 可选配置

### 启用 OpenClaw 原生 TTS

如果你希望优先复用 OpenClaw 原生 TTS 和摘要模型，把 `messages.tts` 从 `false` 改成：

```json5
{
  messages: {
    tts: {
      provider: "microsoft",
      mode: "final",
      auto: "off",
      summaryModel: "openai/gpt-4.1-mini",
      providers: {
        microsoft: {
          voice: "zh-CN-XiaoxiaoNeural",
          rate: "+20%",
          pitch: "0"
        }
      }
    }
  }
}
```

注意：

- `messages.tts: false` 和 `messages.tts: {...}` 二选一
- 如果只是先装好并跑通，先不要启用这一项

### 常用插件配置

```json5
{
  plugins: {
    entries: {
      "feishu-voice-bridge": {
        enabled: true,
        config: {
          defaultVoice: "zh-CN-XiaoxiaoNeural",
          defaultRate: "+20",
          defaultPitch: "0",
          voiceReplySummaryPrefix: "语音摘要：",
          voiceReplySummarySuffix: "（完整内容请查看文字回复）",
          promptToolTtsForText: false
        }
      }
    }
  }
}
```

常用字段：

- `voiceReplyEnabled`：是否启用自动语音回复
- `voiceReplyMode`：`inbound` / `always` / `off`
- `voiceReplyWindowMs`：最近一次飞书入站消息后的语音回复窗口
- `voiceReplyCooldownMs`：两次自动语音回复最小间隔
- `voiceReplyDebounceMs`：等待文本稳定后再发送
- `voiceReplyTextSendingFallbackMs`：只有 `message_sending` 但没有 `message_sent` 时的兜底等待时间
- `voiceReplyNoTextFallbackMs`：没有文本发送钩子时，允许 assistant 最终文本兜底发语音的等待时间
- `voiceReplyAssistantSettleMs`：`assistant_message` 连续写入后，等待正文收敛的最小时间
- `voiceReplyRetryCount`：后台语音发送失败后的重试次数
- `voiceReplyRetryBackoffMs`：后台语音发送失败后的重试间隔基数，实际为 `基数 x 当前尝试次数`
- `maxReplyChars`：最终朗读文本上限
- `maxCapturedReplyChars`：摘要前缓存文本上限
- `enableBeforeAgentReply`：宿主支持时，允许更早捕获最终回复正文
- `voiceReplySummaryEnabled`：长文本是否改为摘要朗读
- `voiceReplySummaryMaxSentences`：摘要最多保留几句

## 开发模式

只有本地开发调试时才使用 link 模式；普通使用不要这样装：

```bash
git clone git@github.com:alpar/feishu-voice-bridge.git ~/feishu-voice-bridge
openclaw plugins install -l ~/feishu-voice-bridge
```

## 依赖自检

```bash
python3 --version
ffmpeg -version
ffprobe -version
edge-tts --help >/dev/null && echo "edge-tts ok"
whisper --help >/dev/null && echo "whisper ok"
```

Windows PowerShell 参考：

```powershell
py --version
ffmpeg -version
ffprobe -version
edge-tts --help
whisper --help
```

## 手工调试脚本

这些脚本仅用于本地手工调试，不属于插件运行主链路。

```bash
# 测试语音合成：
node scripts/send_voice.js -t "这是一条测试语音" --no-send -o /tmp/feishu-voice-test.opus
test -f /tmp/feishu-voice-test.opus && echo "tts script ok"

# Whisper 测试：
node scripts/openclaw_stt.js /tmp/feishu-voice-test.opus
```

Windows PowerShell 参考：

```powershell
node scripts/send_voice.js -t "这是一条测试语音" --no-send -o "$env:TEMP\\feishu-voice-test.opus"
Test-Path "$env:TEMP\\feishu-voice-test.opus"
node scripts/openclaw_stt.js "$env:TEMP\\feishu-voice-test.opus"
```

## 常见问题

- 拉了代码但没执行 `openclaw plugins install <path>`
- 误用了 `openclaw plugins install feishu-voice-bridge`
- 插件未正确安装，或源码目录没有通过 `plugins.load.paths` 加入加载路径
- 没配置 `channels.feishu.appId` / `channels.feishu.appSecret`
- 改完配置没有重启 Gateway
- 本机缺少 `ffmpeg` / `ffprobe` / `edge-tts` / `whisper`
- 旧版 `tools.media.audio.models` 仍然指向 `openclaw_stt.sh`
- 误以为 `.env.example` 会被自动加载

## 排查

先跑这三个检查：

```bash
cd ~/.openclaw/extensions/feishu-voice-bridge
npm run check
npm test
openclaw plugins info feishu-voice-bridge
```

如果还不对，再执行：

```bash
openclaw status --all
```

重点看这些日志关键词：

- `runtime ready: tts=...`
- `toolTts=...`
- `toolStt=...`
- `feishu-voice synthesized via OpenClaw TTS`
- `feishu-voice transcribed via OpenClaw runtime`
- `feishu-voice auto reply sent`
- `feishu-voice skip auto reply: ...`

## 安全说明

插件运行时读取的是：

- `channels.feishu.appId`
- `channels.feishu.appSecret`

手工调用 `scripts/send_voice.js` 时，还会读取：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_CHAT_ID`
- `OPENCLAW_JSON`

不要把真实密钥、token、聊天标识提交进仓库。

## 开发命令

```bash
npm run check
npm test
```
