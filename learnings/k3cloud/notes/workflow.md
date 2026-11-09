# 金蝶云星空 (K3Cloud HTML5) 自动化经验笔记

## 1. 核心上下文门禁 (`guardExpression`)

- 推荐使用：`location.href.toLowerCase().includes('k3cloud')`
- 登录态与验证码处理：若遇到滑块或短信验证码，必须调用 `cdp.waitForUserAuth` 或 `cdp.captureUniquePng` 交由用户确认，严禁将账套密码写入脚本或 Git 仓库。

## 2. 避免使用动态生成 ID，优先使用语义定位器与快照 `@ref`

- 金蝶 HTML5 界面每次打开页签会生成动态前缀 ID（如 `F83920_...`）。
- **推荐定位方式**：
  1. 先调用 `await cdp.snapshotText(page, guard, { interactiveOnly: true })` 获取当前可见控件与 `@e1` 引用。
  2. 工具栏按钮优先使用语义角色或文本定位：
     - `role:button[name="查询"]` 或 `text="过滤"`
     - `.kd-btn:has-text("刷新")`
  3. 遇到多个同名按钮（例如后台挂起的隐藏页签中也有“查询”按钮）：
     - `AgentBrowserBridge` 的 `locator.js` 已内置**唯一可见副本自动收敛**，会自动忽略后台隐藏页签中的同名节点；
     - 若同一可见区域仍有多个同名按钮，使用 `role:button[name="查询"] >> nth=0` 精确消歧。
