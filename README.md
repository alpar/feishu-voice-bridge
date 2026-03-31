# 飞书语音桥接插件

`feishu-voice-bridge` 是一个 OpenClaw 原生插件，用来把飞书语音收发能力接入 OpenClaw 的标准语音链路，而不是在渠道层做额外分叉。

它当前提供三项能力：

1. 为官方 `tts` 工具注册 `feishu-voice` 语音提供方
2. 为飞书入站语音消息注册 `feishu-voice` 转写提供方
3. 为飞书场景提供自动语音回复桥接，把最终回复转换成独立飞书语音消息

## 插件目标

这个插件遵循几条固定原则：

- TTS 策略、提供方选择和回复流程尽量交给 OpenClaw Core 统一管理
- 飞书特有的上传、发送和会话状态管理收敛在插件内部
- 优先使用官方 Hook，而不是去改 `openclaw-lark`
- 能复用官方 `tts` 产物时尽量复用，避免同一段文本重复合成
- 会话路由要容忍 `open_id` 和 `chat_id` 在不同事件里的别名漂移
- 自动语音回复以最终文本为准，文本一致时优先复用官方 `tts` 已生成的音频

## 目录说明

- `index.js`
  - 插件入口，只负责组装配置、Provider 和 Hook
- `lib/constants.js`
  - 统一维护默认值和公共常量
- `lib/config.js`
  - 解析插件配置
  - 统一合并默认值、网关配置和请求级覆盖参数
- `lib/core-bridge.js`
  - 收口 OpenClaw 原生语音运行时加载
  - 统一复用原生摘要与原生 TTS 合成入口
- `lib/runtime.js`
  - 启动时探测原生 TTS、脚本兜底、STT 脚本和 `ffprobe` 可用性
- `lib/speech-text.js`
  - 收口语音朗读文本清洗、摘要源文本清洗和 transcript echo 匹配
- `lib/text.js`
  - 处理最终语音候选内容的合并策略
  - 对外暴露兼容的文本工具入口
- `lib/voice-reply-summary.js`
  - 处理原生摘要适配与规则摘要兜底
  - 统一生成语音回复摘要上下文
- `lib/feishu.js`
  - 处理飞书目标解析、账号配置和 API 请求
- `lib/audio.js`
  - 处理音频时长探测、音频复用、本地合成与飞书语音发送
- `lib/providers.js`
  - 注册 `feishu-voice` 语音提供方
  - 注册 `feishu-voice` 音频理解提供方
- `lib/voice-reply-store.js`
  - 维护会话状态、待发送回复别名和外部事件去重缓存
- `lib/voice-reply-route.js`
  - 负责飞书目标解析、会话键归一化和入站元数据记忆
- `lib/voice-reply-dispatcher.js`
  - 负责候选回复收集、最终回复选择和 `agent_end` 时机发送
- `lib/voice-reply-hooks.js`
  - 只负责挂接 OpenClaw Hook，把状态、路由和发送逻辑分发给内部模块
- `scripts/send_voice.sh`
  - 封装 Edge TTS 与 `ffmpeg`
  - 统一输出为 OPUS，兼容飞书语音消息上传
- `scripts/openclaw_stt.sh`
  - 封装本地 Whisper 转写，供 OpenClaw 直接接入
- `scripts/voice_to_text.sh`
  - 提供命令行语音转文本能力，便于本地排查和独立验证

## 推荐使用方式

建议采用“插件内闭环”的模式：

- 不修改 `openclaw-lark`
- 飞书语音相关行为全部留在这个插件里
- 通过 OpenClaw 官方 Hook 和官方 `tts` 工具接入能力

## 安装

推荐参考 OpenClaw 官方插件安装方式处理本仓库，不要只把代码拉到任意目录后直接改配置。

### 方式 A：从本地源码安装到 OpenClaw（推荐）

```bash
git clone git@github.com:alpar/feishu-voice-bridge.git ~/feishu-voice-bridge
openclaw plugins install ~/feishu-voice-bridge
```

说明：

- `openclaw plugins install <path>` 会把插件复制到 `~/.openclaw/extensions/feishu-voice-bridge`
- 这是最接近官方插件文档的安装方式，适合普通使用者
- 本插件没有 Node.js 运行时依赖，不需要额外执行 `npm install`

如果你是本地开发者，希望源码改动立即生效，可以改用 link 方式：

```bash
openclaw plugins install -l ~/feishu-voice-bridge
```

### 方式 B：手动放到全局扩展目录

```bash
mkdir -p ~/.openclaw/extensions
git clone git@github.com:alpar/feishu-voice-bridge.git ~/.openclaw/extensions/feishu-voice-bridge
cd ~/.openclaw/extensions/feishu-voice-bridge
```

说明：

- 手动安装时，插件目录必须是 `~/.openclaw/extensions/feishu-voice-bridge`
- 如果只是放在业务项目目录里，但没有执行 `openclaw plugins install <path>`，OpenClaw 通常不会自动加载它
- 同样不需要执行 `npm install`

### 安装结果自检

```bash
test -f ~/.openclaw/extensions/feishu-voice-bridge/openclaw.plugin.json && echo "plugin files ok"
openclaw plugins info feishu-voice-bridge
```

## 依赖安装

### 步骤 1：安装系统依赖

```bash
yum install -y ffmpeg       # CentOS / OpenCloudOS
apt-get install -y ffmpeg   # Ubuntu / Debian
brew install ffmpeg         # macOS
```

说明：

- 插件依赖 `ffmpeg` 和 `ffprobe` 处理转码与时长探测
- 这两个命令缺失时，语音发送链路通常会失败

### 步骤 2：安装 Python 依赖

```bash
# 基础依赖
pip install edge-tts

# 语音转文字功能（可选）
pip install openai-whisper
```

说明：

- `edge-tts` 用于脚本兜底 TTS，建议安装
- `openai-whisper` 只在你需要本地 STT 兜底时安装
- 如果你完全依赖 OpenClaw 原生 STT，可先不安装 `openai-whisper`

### 步骤 3：验证依赖安装

```bash
ffmpeg -version
ffprobe -version
python -c "import edge_tts; print('edge-tts ok')"
python -c "import whisper; print('whisper ok')"  # 可选
```

### 步骤 4：验证脚本链路

```bash
cd ~/.openclaw/extensions/feishu-voice-bridge
bash scripts/send_voice.sh -t "这是一条测试语音" --no-send -o /tmp/feishu-voice-test.opus
test -f /tmp/feishu-voice-test.opus && echo "tts script ok"
```

如果你安装了本地 Whisper，也可以继续验证：

```bash
bash scripts/openclaw_stt.sh /tmp/feishu-voice-test.opus
```

## 配置

OpenClaw 配置文件通常位于：

```bash
~/.openclaw/openclaw.json
```

在开始前，请先准备好：

- 一个已经接入 OpenClaw 的飞书应用
- 该应用的 `App ID` 与 `App Secret`
- 让机器人具备接收消息、上传文件、发送音频消息所需的飞书侧权限与事件订阅

至少要同时配置三部分：

1. `channels.feishu.*`：飞书渠道凭证
2. `plugins.entries.feishu-voice-bridge.*`：插件启用与桥接策略
3. `messages.tts.*`：推荐配置，决定原生 TTS 与长文本摘要模型

### 最小可运行配置

下面示例可直接作为起点：

```json5
{
  channels: {
    feishu: {
      appId: "cli_xxxxxxxxxxxxx",
      appSecret: "xxxxxxxxxxxxx"
    }
  },
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

### 必要配置说明

- `channels.feishu.appId`
  - 飞书应用的 App ID，必填
- `channels.feishu.appSecret`
  - 飞书应用的 App Secret，必填
- `plugins.entries.feishu-voice-bridge.enabled`
  - 必须为 `true`
- `plugins.entries.feishu-voice-bridge.config.voiceReplyEnabled`
  - 是否启用飞书自动语音桥接
- `plugins.entries.feishu-voice-bridge.config.voiceReplyMode`
  - `inbound` 只在最近有语音入站时自动回语音
  - `always` 始终允许自动语音回复
  - `off` 关闭自动语音发送
- `messages.tts.provider`
  - 推荐配置，决定插件优先复用哪条 OpenClaw 原生 TTS 链路
- `messages.tts.summaryModel`
  - 推荐配置，长文本语音摘要优先使用的模型；未设置时回退到 `agents.defaults.model.primary`

如果没有配置 `channels.feishu.appId` 或 `channels.feishu.appSecret`，插件可能显示已加载，但实际发送飞书语音一定会失败。

### 推荐配置补充

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

常用配置项：

- `voiceReplyWindowMs`：语音入站后允许自动回语音的窗口时间
- `voiceReplyCooldownMs`：两次自动语音发送的最小间隔
- `voiceReplyDebounceMs`：等待文本稳定后再发语音的延迟
- `maxReplyChars`：最终朗读文本上限
- `maxCapturedReplyChars`：用于摘要前缓存的最大文本长度
- `voiceReplySummaryEnabled`：长文本是否改为摘要朗读
- `voiceReplySummaryMaxSentences`：摘要最多保留几句
- `scriptPath` / `sttScriptPath`：只在你要覆盖插件自带脚本时配置

## 生效步骤

保存配置后，重启 Gateway：

```bash
sh ~/.openclaw/scripts/restart.sh
```

如果你的 OpenClaw 不在默认目录，请改成自己的 `OPENCLAW_HOME/scripts/restart.sh`。

## 安装后验证

### 步骤 1：验证插件代码本身可加载

```bash
cd ~/.openclaw/extensions/feishu-voice-bridge
npm run check
npm test
```

预期结果：

- `npm run check` 成功退出
- `npm test` 全部通过

### 步骤 2：验证 OpenClaw 已加载插件

```bash
openclaw plugins info feishu-voice-bridge
openclaw status --all
```

重点检查：

- 插件 `feishu-voice-bridge` 已启用
- `speech provider` 中能看到 `feishu-voice`
- `media understanding provider` 中能看到 `feishu-voice`

### 步骤 3：观察原生能力是否被复用

启动后观察日志，出现以下关键词说明对应链路已命中：

- `runtime ready: nativeTts=...`
- `nativeStt=...`
- `summary=...`
- `feishu-voice synthesized via OpenClaw TTS`
- `feishu-voice transcribed via OpenClaw runtime`

## 功能测试

建议按下面顺序做完整验收：

1. 在飞书里发送一条语音消息给 OpenClaw 机器人
2. 确认 OpenClaw 能正常转写并回复文本
3. 确认插件额外发送了一条飞书语音消息
4. 再发送一条超长问题，确认语音回复读的是摘要，而不是简单截断
5. 再发送一条包含 emoji 的文本，确认语音朗读会跳过 emoji 表情

如果你开启了 `voiceReplyMode: "inbound"`，请在入站窗口内测试；超过 `voiceReplyWindowMs` 后，自动语音回复会被抑制。

## 与 OpenClaw 原生能力的关系

这个插件不是绕开官方 TTS / STT，而是补齐飞书语音发送这一层。

核心行为：

- `tts` 工具可以直接使用 `feishu-voice`
- 自动语音回复会优先复用 OpenClaw 原生 `messages.tts` 链路做摘要和合成
- 飞书入站语音转写会优先复用 OpenClaw 原生 `api.runtime.stt.transcribeAudioFile(...)`
- 插件能复用原生 provider 已生成的 `opus`、`ogg`、`mp3`、`wav`、`m4a` 音频
- 原生 TTS / STT 不可用时，才会回退到插件脚本

语音参数兼容入口：

- 推荐：`messages.tts.providers.microsoft.*`
- 兼容：`messages.tts.microsoft.*`
- 兼容：`messages.tts.edge.*`

## 常见安装失败原因

- 只拉了代码，但没有执行 `openclaw plugins install <path>`，也没有把目录放到 `~/.openclaw/extensions/feishu-voice-bridge`
- 没有填写 `channels.feishu.appId` / `channels.feishu.appSecret`
- 配置改完后没有执行 `sh ~/.openclaw/scripts/restart.sh`
- 本机缺少 `ffmpeg` / `ffprobe` / `edge-tts`
- 误以为仓库里的 `.env.example` 会被插件自动加载；实际上不会自动加载

## 安全配置说明

本插件不会在仓库中保存任何飞书密钥，但运行时会读取这些敏感项：

- `channels.feishu.appId`
- `channels.feishu.appSecret`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_CHAT_ID`

推荐做法：

- 通过 OpenClaw 本地配置、shell、launchd 或 CI Secret 注入真实值
- 提交前确认不要把真实 `appId`、`appSecret`、token 或聊天标识写进仓库
- 排查问题时，不要直接贴出完整日志里的 `Authorization` 头、token 或 `file_key`

仓库根目录提供了 `.env.example` 作为变量清单示例，但插件本身不会自动加载 `.env` 文件。

## 开发命令

```bash
npm run check
npm test
```

## 排查清单

1. 执行 `openclaw plugins info feishu-voice-bridge`
2. 确认插件已加载，并且 `speech: feishu-voice` 已注册
3. 在网关日志里检查这些关键词：
   - `feishu-voice captured generated audio`
   - `feishu-voice auto reply sent`
   - `feishu-voice skip auto reply: ...`
4. 如果文本轮次没有发声，继续检查：
   - 当前渠道是否正常触发了出站 `message_sent`
   - 是否只在需要复用官方音频时才开启了 `promptToolTtsForText`
   - 提示注入是否被插件 Hook 策略拦截
   - 如果你期待的是“复用官方 `tts` 音频”，模型是否真的调用了 `tts`
