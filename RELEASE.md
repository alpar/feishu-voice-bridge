# 发布说明

## 当前版本

- 版本号：`2026.3.31`
- git tag：`feishu-voice-bridge-v20260331`

## 建议发布流程

1. 确认工作区内只包含本插件相关改动。
2. 执行测试：

```bash
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

- 新增长文本语音摘要逻辑，避免超长内容直接被截断。
- 插件文档、注释和测试标题统一改为中文。
- 补齐基础项目文件，方便后续维护、发布和协作。
