# 飞书语音桥接插件

`feishu-voice-bridge` 是一个 OpenClaw 原生插件，用于：

1. 注册 `feishu-voice` TTS provider
2. 注册飞书语音转写 provider
3. 在飞书场景把最终文本回复补发为语音消息

## 安装

推荐方式：

```bash
git clone git@github.com:alpar/feishu-voice-bridge.git ~/feishu-voice-bridge
openclaw plugins install ~/feishu-voice-bridge
```

开发场景也可以 link：

```bash
openclaw plugins install -l ~/feishu-voice-bridge
```

手动放置目录时，插件路径必须是：

```bash
~/.openclaw/extensions/feishu-voice-bridge
```

安装后可检查：

```bash
openclaw plugins info feishu-voice-bridge
```

## 依赖安装

系统依赖：

```bash
yum install -y ffmpeg       # CentOS / OpenCloudOS
apt-get install -y ffmpeg   # Ubuntu / Debian
brew install ffmpeg         # macOS
```

Python 依赖：

```bash
python3 -m pip install edge-tts
python3 -m pip install openai-whisper  # 可选
```

依赖检查：

```bash
python3 --version
ffmpeg -version
ffprobe -version
edge-tts --help >/dev/null && echo "edge-tts ok"
whisper --help >/dev/null && echo "whisper ok"  # 可选
```

脚本链路检查：

```bash
cd ~/.openclaw/extensions/feishu-voice-bridge
bash scripts/send_voice.sh -t "这是一条测试语音" --no-send -o /tmp/feishu-voice-test.opus
test -f /tmp/feishu-voice-test.opus && echo "tts script ok"
```

如安装了 Whisper，可继续测试：

```bash
bash scripts/openclaw_stt.sh /tmp/feishu-voice-test.opus
```

## 配置

OpenClaw 配置文件通常位于：

```bash
~/.openclaw/openclaw.json
```

必填配置只有两部分：

1. `channels.feishu.*`
2. `plugins.entries.feishu-voice-bridge.*`

`messages.tts.*` 是可选增强配置。

### 最小可运行配置

这是推荐默认示例，和你当前使用方式一致：

```json5
{
  channels: {
    feishu: {
      appId: "cli_xxxxxxxxxxxxx",
      appSecret: "xxxxxxxxxxxxx"
    }
  },
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

- `messages.tts: false` 是合法配置
- 插件仍可工作，并使用自己的脚本完成语音合成
- 超长文本仍会走插件内置摘要逻辑

### 可选：启用原生 TTS 复用

如果你希望优先复用 OpenClaw 原生 TTS / 摘要模型，把上面的 `messages.tts` 改成：

```json5
{
  messages: {
    tts: {
      provider: "edge",
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
- 不需要原生 TTS 复用时，保持 `messages.tts: false` 即可

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
- `maxReplyChars`：最终朗读文本上限
- `maxCapturedReplyChars`：摘要前缓存文本上限
- `voiceReplySummaryEnabled`：长文本是否改为摘要朗读
- `voiceReplySummaryMaxSentences`：摘要最多保留几句

如果没有配置 `channels.feishu.appId` 或 `channels.feishu.appSecret`，插件即使已加载，也无法发送飞书语音。

## 生效

修改配置后重启：

```bash
sh ~/.openclaw/scripts/restart.sh
```

## 验证

插件自检：

```bash
cd ~/.openclaw/extensions/feishu-voice-bridge
npm run check
npm test
```

确认插件已加载：

```bash
openclaw plugins info feishu-voice-bridge
```

重点看：

- 插件状态为已加载
- `speech` 中有 `feishu-voice`
- `media-understanding` 中有 `feishu-voice`

## 功能测试

建议按顺序测试：

1. 发一条飞书语音给机器人
2. 确认能转写并正常回文本
3. 确认插件额外补发了一条飞书语音
4. 发一条超长问题，确认语音读的是摘要
5. 发一条包含 emoji 的文本，确认语音会跳过 emoji

`voiceReplyMode: "inbound"` 下，自动语音回复只会在最近一次飞书入站消息后的窗口内触发。

## 常见问题

- 拉了代码但没执行 `openclaw plugins install <path>`
- 插件目录不在 `~/.openclaw/extensions/feishu-voice-bridge`
- 没配置 `channels.feishu.appId` / `channels.feishu.appSecret`
- 改完配置没有重启 Gateway
- 本机缺少 `ffmpeg` / `ffprobe` / `edge-tts`
- 误以为 `.env.example` 会被自动加载

## 排查

先执行：

```bash
openclaw plugins info feishu-voice-bridge
openclaw status --all
```

再看日志关键词：

- `runtime ready: nativeTts=...`
- `feishu-voice synthesized via OpenClaw TTS`
- `feishu-voice transcribed via OpenClaw runtime`
- `feishu-voice auto reply sent`
- `feishu-voice skip auto reply: ...`

## 安全说明

插件运行时读取的是：

- `channels.feishu.appId`
- `channels.feishu.appSecret`

手工调用 `scripts/send_voice.sh` 时，还会读取：

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
