# 发布说明

## 当前版本

- 版本号：`2026.4.7`
- git tag：`feishu-voice-bridge-v20260407`

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

- 将 run 绑定入口从旧版 `before_agent_start` 迁移到 `before_model_resolve`，对齐 OpenClaw 新版 hook 语义。
- 消除 `openclaw doctor` 对旧版 `before_agent_start` 的兼容性提示。
- 保持现有自动语音回复状态机和串音修复逻辑不变，仅做兼容层迁移和回归测试补强。
