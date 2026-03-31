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

## 安装说明

### 步骤 1：安装依赖

```bash
# 基础依赖
pip install edge-tts

# 语音转文字功能（可选）
pip install openai-whisper

# 安装 ffmpeg
yum install -y ffmpeg  # CentOS/OpenCloudOS
apt-get install -y ffmpeg  # Ubuntu/Debian
```

补充说明：

- 如果你只使用 TTS，不做语音转文字，可以先不安装 `openai-whisper`
- `ffmpeg` 是语音转码和时长探测的基础依赖，TTS / STT 两条链路都会用到
- 安装完成后，建议执行 `ffmpeg -version` 确认系统命令可用

## 与官方 OpenClaw TTS 的关系

这个插件不是绕开官方 TTS，而是补齐飞书语音发送这一层。

核心行为：

- `tts` 工具可以直接使用 `feishu-voice`
- 自动语音回复会优先复用 OpenClaw 原生 `messages.tts` 链路做摘要和合成
- 飞书入站语音转写会优先复用 OpenClaw 原生媒体理解/STT 运行时
- 插件能复用 `tts` 工具或原生 provider 生成的 `opus / ogg / mp3 / wav / m4a` 音频
- 如果没有可用的 `tts` 调用，插件可以回退到最终出站文本进行合成
- 语音参数支持从 `messages.tts.providers.microsoft.*`、`messages.tts.microsoft.*`、`messages.tts.edge.*` 读取
- 长文本摘要优先走 `messages.tts.summaryModel`，未设置时回退到 `agents.defaults.model.primary`
- 单条回复中的 `[[tts:...]]` 指令仍然走官方工具契约

插件负责的内容：

- 飞书自动语音桥接的语音窗口、冷却、去抖和重复抑制
- 飞书语音文件上传与发送
- 原生 TTS / STT 不可用时的脚本兜底

## 配置分层建议

建议把配置理解成三层：

- `messages.tts.*`
  - 控制 OpenClaw 原生 TTS 能力
  - 包括 provider 选择、`summaryModel`、语音参数、fallback 等
- `plugins.entries.feishu-voice-bridge.config.*`
  - 控制飞书语音桥接行为
  - 包括自动语音回复窗口、冷却、摘要开关、STT 脚本和兜底脚本
- `plugins.entries.feishu-voice-bridge.hooks.*`
  - 控制插件 Hook 行为
  - 常用的是 `allowPromptInjection`，用于决定是否允许插件注入“尽量调用官方 tts”的提示

推荐优先把 TTS 主配置写在 `messages.tts`，插件配置只负责飞书桥接与兜底。

插件内部现在也按下面四组结构来组织配置，虽然对外仍保持兼容的平铺字段：

- `tts.*`
  - 兜底合成脚本路径，以及脚本兜底时使用的默认音色参数
- `stt.*`
  - 本地语音转写脚本、默认语言和模型
  - 当 OpenClaw 原生 `runtime.stt` 可用时，插件会优先走原生转写
- `voiceReply.timing.*`
  - 入站窗口、冷却、去抖
- `voiceReply.summary.*`
  - 长文本摘要开关、句数、连接符和前后缀

## 配置示例

```json
{
  "plugins": {
    "entries": {
      "feishu-voice-bridge": {
        "enabled": true,
        "config": {
          "defaultVoice": "zh-CN-XiaoxiaoNeural",
          "defaultRate": "+20",
          "defaultPitch": "0",
          "voiceReplyEnabled": true,
          "voiceReplyMode": "inbound",
          "voiceReplyWindowMs": 1200000,
          "voiceReplyCooldownMs": 30000,
          "voiceReplyDebounceMs": 2500,
          "maxReplyChars": 280,
          "maxCapturedReplyChars": 6000,
          "voiceReplySummaryEnabled": true,
          "voiceReplySummaryMaxSentences": 3,
          "voiceReplySummaryPrefix": "语音摘要：",
          "voiceReplySummarySuffix": "（完整内容请查看文字回复）",
          "promptToolTtsForText": false
        }
      }
    }
  }
}
```

### 关键配置项

- `voiceReplyEnabled`：控制是否启用飞书自动语音桥接
- `voiceReplyMode`
  - `inbound`：只在有效入站窗口内自动发送语音
  - `always`：始终允许自动语音回复
  - `off`：关闭自动语音发送
- `voiceReplyWindowMs`：用户入站后多久内仍允许自动语音回复
- `voiceReplyCooldownMs`：两次自动语音发送之间的最小间隔
- `voiceReplyDebounceMs`：等待文本稳定后再发送语音的延迟时间
- `maxReplyChars`：最终发声文本的长度上限
- `maxCapturedReplyChars`：内部缓存文本的最大长度，主要用于长文本摘要
- `voiceReplySummaryEnabled`：长文本是否自动改为“摘要发声”
- `voiceReplySummaryMaxSentences`：长文本摘要最多保留几句
- `voiceReplySummaryPrefix` / `voiceReplySummarySuffix`：规则摘要回退时使用的前后缀
- `promptToolTtsForText`：是否在文本轮次提示模型主动调用官方 `tts`
- `sttLanguage` / `sttModel`：本地 Whisper STT 脚本的默认语言与模型
- `scriptPath` / `sttScriptPath`：覆盖插件自带脚本路径，仅在你需要自定义脚本时使用
- `defaultVoice` / `defaultRate` / `defaultPitch`：插件脚本兜底合成时使用的默认参数

### 原生 STT 说明

- 如果当前 OpenClaw 已配置可用的音频理解 provider，插件会优先调用 `api.runtime.stt.transcribeAudioFile(...)`
- 只有在原生 STT 不可用或调用失败时，才会回退到 `scripts/openclaw_stt.sh`
- 因此 `sttScriptPath` 现在主要承担“离线/兜底”角色，而不是默认主链路

## 配置建议

### 原生 TTS 配置

建议把主 TTS 能力交给 OpenClaw 原生 `messages.tts.*`，插件只负责飞书桥接：

```json
{
  "messages": {
    "tts": {
      "provider": "edge",
      "auto": "off",
      "mode": "final",
      "summaryModel": "openai/gpt-4.1-mini",
      "providers": {
        "microsoft": {
          "voice": "zh-CN-XiaoxiaoNeural",
          "rate": "+20%",
          "pitch": "0"
        }
      }
    }
  }
}
```

- 推荐把 `messages.tts.provider` 配成原生 provider（如 `edge`、`openai`、`elevenlabs`），这样插件会优先复用原生摘要和原生合成
- 推荐优先写 `messages.tts.providers.microsoft.*`，这和 OpenClaw 当前的 provider 配置模型更一致
- 如果你没有配置 `messages.tts.summaryModel`，长文本语音摘要会自动回退到 `agents.defaults.model.primary`
- `messages.tts.provider` 指定当前主 provider
- `messages.tts.summaryModel` 控制长文本语音摘要使用的模型
- 单次调用时传入的 `providerConfig / providerOverrides` 会优先于静态配置生效

### 语音参数配置入口

语音参数可以写在这些位置：

```json
{
  "messages": {
    "tts": {
      "provider": "edge",
      "microsoft": {
        "voice": "zh-CN-XiaoxiaoNeural",
        "rate": "+20%",
        "pitch": "0"
      },
      "edge": {
        "voice": "zh-CN-XiaoxiaoNeural"
      }
    }
  }
}
```

- 推荐入口：`messages.tts.providers.microsoft.*`
- 也支持：`messages.tts.microsoft.*`
- 也支持：`messages.tts.edge.*`
- 当 `feishu-voice` 自己作为 TTS provider 使用时，也会读取当前调用传入的 `providerConfig / providerOverrides`

### 插件桥接配置

下面这些配置属于插件本身的飞书桥接层：

```json
{
  "plugins": {
    "entries": {
      "feishu-voice-bridge": {
        "enabled": true,
        "config": {
          "voiceReplyEnabled": true,
          "voiceReplyMode": "inbound",
          "voiceReplySummaryEnabled": true,
          "defaultVoice": "zh-CN-XiaoxiaoNeural",
          "defaultRate": "+20",
          "defaultPitch": "0",
          "scriptPath": "./scripts/send_voice.sh",
          "sttScriptPath": "./scripts/openclaw_stt.sh"
        }
      }
    }
  }
}
```

- 如果把 `feishu-voice` 作为当前 TTS provider，插件会使用自身的合成与桥接逻辑完成发送
- 即使不打开 `promptToolTtsForText`，文本最终回复也可以走原生合成或插件兜底合成
- 打开 `promptToolTtsForText` 时，插件会在文本轮次提示模型主动调用官方 `tts`，从而更容易复用已生成音频
- 如果通过 `plugins.entries.feishu-voice-bridge.hooks.allowPromptInjection: false` 禁止提示注入，插件仍然可以工作
- `scriptPath` 和 `sttScriptPath` 默认会自动指向插件目录下的 `scripts/`，只有需要覆盖默认脚本时才需要显式配置
- 如果已经配置好原生 `messages.tts.provider`，即使暂时不设置 `scriptPath` 兜底脚本，插件的大部分 TTS 能力仍可工作
- 修改配置后需要重启网关

## 安全配置说明

本插件不会在仓库中保存任何飞书密钥，但运行时会从以下位置读取敏感配置：

- `channels.feishu.appId`
- `channels.feishu.appSecret`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_CHAT_ID`

推荐做法：

- 开发环境使用本机环境变量或 OpenClaw 本地配置文件注入密钥
- 提交前确认不要把真实 `appId`、`appSecret`、token 或聊天标识写进仓库
- 排查问题时，不要直接贴出完整日志中的 `Authorization` 头、token 或 file key

仓库根目录提供了 `.env.example` 作为变量清单示例，但插件本身不会自动加载 `.env` 文件；如果你要用它，请通过 shell、launchd、CI Secret 或其他外部方式注入环境变量。

## 开发命令

```bash
npm test
```

当前测试命令会执行 `node --test index.test.js`。

## 排查清单

1. 执行 `openclaw plugins inspect feishu-voice-bridge`
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

## 发布说明

- 发布或打包时需要包含 `lib/` 与 `scripts/`，否则插件入口无法正常加载内部模块
- 当前 `package.json` 已把 `lib/`、`scripts/`、`README.md`、`LICENSE` 等文件纳入发布清单
