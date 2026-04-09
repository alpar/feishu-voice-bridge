# 发布说明

## 当前版本

- 版本号：`2026.4.8`
- git tag：`feishu-voice-bridge-v20260408`

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

- 修复长文本语音摘要没有命中 OpenClaw 原生 LLM 摘要能力、退回规则截断的问题。
- 摘要桥接层优先调用正式 `summarizeText()`，旧 `_test.summarizeText` 仅保留为兼容兜底。
- 增强 OpenClaw speech-core API 加载路径兼容，适配新版包导出结构。
- 为原生摘要目标长度增加最小值保护，避免被宿主拒绝后退回规则摘要。
