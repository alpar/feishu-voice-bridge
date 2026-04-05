# 发布说明

## 当前版本

- 版本号：`2026.4.5`
- git tag：`feishu-voice-bridge-v20260405`

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

- 插件主流程统一切换到 Node 工具链，移除运行链路中的 Bash 依赖。
- 仓库内调试脚本已全部迁移为 Node 版本，`openclaw.json` 旧 `.sh` 配置需要同步升级。
- 修复 Windows 下命令探测兼容问题，补充跨平台文档与调试说明。
- 修复插件在 `register()` 阶段加载原生 speech runtime 导致的递归 / 自引用问题。
