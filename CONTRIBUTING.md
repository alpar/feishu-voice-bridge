# 贡献指南

感谢你参与维护 `feishu-voice-bridge`。

## 开发原则

- 优先遵循 OpenClaw 官方插件机制，不修改渠道插件核心实现。
- 飞书特有逻辑尽量收敛在本插件内部。
- 文本、语音和最终用户可见回复必须尽量保持一致。
- 新增能力时，优先补测试，再补实现。

## 本地开发

### 环境要求

- Node.js 20 及以上
- `ffmpeg`
- `edge-tts`
- `whisper`

### 常用命令

```bash
npm test
npm run check
```

## 提交规范

- 文档、配置、代码和测试尽量同一批次提交，避免上下文割裂。
- 如果改动影响语音发送策略，请同步更新 `README.md` 和 `CHANGELOG.md`。
- 如果新增配置项，请同步更新：
  - `openclaw.plugin.json`
  - `README.md`
  - 对应测试

## 敏感信息要求

- 不要提交真实的 `appId`、`appSecret`、token、聊天标识或任何其他生产凭证。
- `.env.example` 只保留变量名和占位值，不写入真实配置。
- 如果需要展示日志，请先脱敏 `Authorization`、`tenant_access_token`、`file_key` 等字段。

## 测试要求

- 修改 `index.js` 中的桥接逻辑后，至少运行一次 `npm test`。
- 修改调试脚本参数或帮助文本后，检查 `README.md` 中的示例是否仍然准确。
- 如果改动会影响 `openclaw.json` 中 `tools.media.audio.models` 的 CLI 配置格式，请同步补充升级迁移说明。
- 如果修复的是飞书语音时序问题，建议补一条对应的回归测试。

## 发布前检查

发布前建议确认以下事项：

1. `npm test` 通过。
2. `README.md` 中的配置示例与当前实现一致。
3. `openclaw.plugin.json` 中的配置 schema 已同步更新。
4. `CHANGELOG.md` 已记录本次版本变化。
5. 需要的 git tag 已创建。
