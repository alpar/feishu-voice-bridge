# 飞书语音桥接插件

`feishu-voice-bridge` 是一个 OpenClaw 原生插件，用来把飞书语音收发能力接入 OpenClaw 的标准语音链路，而不是在渠道层做额外分叉。

它当前提供三项能力：

1. 为官方 `tts` 工具注册 `feishu-voice` 语音提供方
2. 为飞书入站语音消息注册 `feishu-voice` 转写提供方
3. 为飞书场景提供自动语音回复桥接，把最终回复转换成独立飞书语音消息

## 插件目标

这个插件最初是为了解决一个很具体的问题：飞书语音消息虽然能转写，但语音回传常常不稳定、延迟高，而且容易和渠道特有逻辑绑死。

第一轮实现之后，沉淀出了几条比较明确的原则：

- TTS 策略、提供方选择和回复流程尽量交给 OpenClaw Core 统一管理
- 飞书特有的上传、发送和会话状态管理收敛在插件内部
- 优先使用官方 Hook，而不是去改 `openclaw-lark`
- 能复用官方 `tts` 产物时尽量复用，避免同一段文本重复合成
- 会话路由要容忍 `open_id` 和 `chat_id` 在不同事件里的别名漂移

当前版本沿着这个方向继续收敛。

这一版还有一个重要变化：语音发送不再只依赖模型是否在最终回复前成功调用 `tts`。插件会同时监听飞书真实出站文本，在没有可复用音频时，直接以最终文本为准进行本地合成；如果 `tts` 产物与最终文本一致，则继续优先复用官方产物。

## 目录说明

- `index.js`
  - 插件入口，只负责组装配置、Provider 和 Hook
- `lib/constants.js`
  - 统一维护默认值和公共常量
- `lib/config.js`
  - 解析插件配置
  - 统一合并默认值、网关配置和请求级覆盖参数
- `lib/text.js`
  - 处理发声文本清洗
  - 处理长文本摘要
  - 处理最终语音候选内容的合并策略
- `lib/feishu.js`
  - 处理飞书目标解析、账号配置和 API 请求
- `lib/audio.js`
  - 处理音频时长探测、音频复用、本地合成与飞书语音发送
- `lib/providers.js`
  - 注册 `feishu-voice` 语音提供方
  - 注册 `feishu-voice` 音频理解提供方
- `lib/voice-reply-hooks.js`
  - 维护飞书会话状态，包括语音窗口、冷却和去重控制
  - 在需要时通过 `before_prompt_build` 注入提示，引导文本回复也调用官方 `tts`
  - 捕获最终出站文本，保证文本和语音内容尽量一致
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

当前已经兼容的行为包括：

- `tts` 工具可以直接使用 `feishu-voice`
- 插件能复用 `tts` 工具生成的 OPUS 音频
- 如果没有可用的 `tts` 调用，插件可以回退到最终出站文本进行合成
- 语音参数会兼容 Microsoft / Edge 风格配置：
  - `messages.tts.microsoft.voice`
  - `messages.tts.microsoft.rate`
  - `messages.tts.microsoft.pitch`
  - 兼容旧版 `messages.tts.edge.*` 别名
- 单条回复中的 `[[tts:...]]` 指令仍然走官方工具契约

插件侧有意保留的差异包括：

- 飞书自动语音桥接仍然保留语音窗口、冷却、去抖和重复抑制规则
- 输出格式固定优先 OPUS，因为飞书投递成功率更重要
- `microsoft.outputFormat` 暂不作为稳定插件协议暴露

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
- `voiceReplySummaryPrefix` / `voiceReplySummarySuffix`：摘要语音的前后缀
- `promptToolTtsForText`：是否在文本轮次提示模型主动调用官方 `tts`

## 推荐的 OpenClaw 设置

建议和官方 TTS 配置一起使用：

```json
{
  "messages": {
    "tts": {
      "provider": "feishu-voice",
      "auto": "off",
      "mode": "final",
      "microsoft": {
        "voice": "zh-CN-XiaoxiaoNeural",
        "rate": "+20%",
        "pitch": "0"
      }
    }
  }
}
```

补充说明：

- 即使不打开 `promptToolTtsForText`，文本最终回复也可以走本地合成
- 打开 `promptToolTtsForText` 的主要价值，是让插件更容易复用官方 `tts` 已生成的音频
- 如果通过 `plugins.entries.feishu-voice-bridge.hooks.allowPromptInjection: false` 禁止提示注入，插件仍然可以工作，只是失去这条额外引导
- `scriptPath` 和 `sttScriptPath` 默认会自动指向插件目录下的 `scripts/`，只有需要覆盖默认脚本时才需要显式配置
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

## 后续可继续完善的方向

- 把当前静态音色列表收敛成一个更明确的提供方音色目录
- 当更多渠道暴露稳定语音附件元数据时，支持直接复用 Core TTS 附件发送
- 增加覆盖语音窗口、冷却和重复抑制的轻量集成测试
