# 发布说明

## 当前版本

- 版本号：`2026.4.6`
- git tag：`feishu-voice-bridge-v20260406`

## 建议发布流程

1. 确认工作区内只包含本插件相关改动。
2. 执行测试：

```bash
npm run check
npm test
```

3. 检查以下文件是否已同步：
   - `README.md`
   - `CHANGELOG.md`
   - `openclaw.plugin.json`
   - `package.json`
4. 创建或确认版本 tag。
5. 视需要推送 commit 和 tag。

## 本版重点

- 自动语音回复状态模型按 OpenClaw 最新宿主语义收敛为“每个 session 当前 run”。
- `agent_end.messages` 现在是最终正文主来源，`message_sent` 仅保留发送观测和解锁职责。
- 增加 `activeRunId` 绑定与 stale run 防护，修复旧轮文本/语音迟到导致的新轮串音问题。
- 收紧 `latest_route` 弱路由，只允许观测，不再借它创建新的待发送语音。
