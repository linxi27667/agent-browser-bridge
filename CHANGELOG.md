# 更新日志

## 0.8.0 — 2026-11-15

浏览器与桌面工作流统一入口，保留现有 Node.js/CDP 引擎并适配 agent-desktop 1.3.1。

### 行为变化
- `desktop.ad*` 改为异步 Promise，调用必须 `await`；默认只读、合作模式。
- 物理输入、前台聚焦、剪贴板写入与应用生命周期操作需要显式 exclusive 和允许写入。`adRaw` 同样经过命令与参数检查。
- `npm test` 默认跳过会占用前台的两个旧 GUI 测试；显式 `npm run test:desktop` 才启用它们。

### 新增与修复
- `cli/agent.cjs` 提供 doctor、route、desktop 与可信工作流 run，支持仓外机器配置和固定桌面版本。
- 桌面子进程使用异步无 shell 调用，支持超时、取消、输出上限、独立状态目录和 stdin 文本；不自动重试未知投递。
- `step` 必须独立验收后才能继续，独占任务用跨进程锁串行，未等待步骤结束前不释放锁。
- 修复原型可用性恒真、launch/close 参数与错误回显输入问题；版本预检不接收业务输入。
- 修复共享清单引用未发布私有辅助文件导致全新克隆回归失败的问题；`sync:shared -- --manifest-only` 仅重建本仓指纹，不声称同步公司仓。
- `npm run smoke:workflow` 验证隔离 about:blank → 文件 → 原生 UIA 文本框流程，使用合作模式、无物理输入。

旧四个 PowerShell API 与旧 runScript 仍是可信底层接口，不属于新入口的策略隔离；完整迁移和边界见 `docs/automation.md`。

## 0.7.1 — 2026-11-09

多 Agent 并发、证据截图与金蝶只读操作的硬化版本。

### 行为变化（升级前请留意）
- `withDedicatedTab`：同站点标签页都被其他任务占用时，**默认排队等待**（`onLeased: 'wait'`，`leaseWaitMs` 默认 60000），不再另开第二个标签页并行操作同一站点。需要旧行为传 `onLeased: 'newTab'`；需要立即失败传 `onLeased: 'fail'`。
- 被其他存活进程租用的标签页，`attachTarget` 和直连 `/devtools/page/<id>` 都会抛 `CDP_TARGET_LEASED`。

### 新增
- 只读模式：`withDedicatedTab({ readOnly: true })` / `page.readOnly = true` 时，点击“保存/提交/审核/删除/下推/业务关闭…”等按钮会抛 `READ_ONLY_BLOCKED`，按钮收不到点击（可用 `{ denyText: [...] }` 自定义）。只拦本库发出的点击。
- 外部调试器检测：标签页已被本库之外的程序（其他自动化工具或 F12）连着时默认打印警告，`meta.foreignAttached = true`；`onForeignAttach: 'wait' | 'skip' | 'fail' | 'ignore'` 可调整（`'wait'` 排队等它断开，受 `leaseWaitMs` 限制）。注意：只能在进入标签页前检测，进入后其他工具再连上来无法感知。
- `clickByBox(..., { parkPointer: true })`：点击后把鼠标移开，避免悬停弹出下拉菜单。
- 证据截图（`capturePagePng` / `captureUniquePng` / `saveScreenshot`）自动隐藏桥接 HUD；`page.captureIncludeHud = true` 可保留。
- 页面异常保留具体原因：`Page evaluation failed ...: Input must be unique`，`error.code = 'PAGE_EVAL_FAILED'`，`error.pageReason`。
- 金蝶只读工具 `learnings/k3cloud/tools/k3-actions.cjs` 与 `open-bill`：菜单搜索、快捷过滤字段切换（含 `elementFromPoint` 顶层命中检测 + `aria-owns` 下拉项 `scrollIntoView` 防裁剪）、等网格稳定（防首次加载覆盖、防旧列表误判）、修改模式识别、序列号查询、掉线识别（`K3_SESSION_LOST`）。
- 回归：`tests/hardening.test.cjs`（9 项，两仓共用）、`cli/smoke-k3.cjs`（隔离页面里模拟金蝶 4 类时序/DOM 陷阱的真实浏览器冒烟）、`tests/shared-sync.test.cjs`（两仓共享文件指纹校验，源头 `AgentBrowserBridge-CrossBrowser/scripts/sync-shared.cjs`）。

### 修复
- `clickNative` 纳入 UI 互斥锁，与坐标点击串行。

