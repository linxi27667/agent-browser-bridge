# 电子税务局（广东税务 TDesign 系统）自动化经验笔记

## 1. 上下文门禁与身份认证

- 上下文门禁：`location.hostname.endsWith('.chinatax.gov.cn')`
- 登录与短信/扫码验证：必须由用户在可见调试窗口完成，脚本通过 `cdp.waitForUserAuth` 等待进入业务工作台，严禁留存任何税务凭据。

## 2. 使用语义定位器替代手工 `data-gc-etax` 注入

电子税务局前端大量使用腾讯 TDesign 组件（`.t-input__inner`、`.t-select-option`、`.t-button`、`.t-checkbox`）。借助 `AgentBrowserBridge` 升级后的语义定位器与混合快照引擎，无需再手工遍历 DOM 注入临时属性：

- **点击下拉选项**：
  - `await cdp.clickByBox(page, '.t-select-option:text-is("取得发票")', guard)`
  - `await cdp.clickByBox(page, '.t-select-option:text-is("开具发票")', guard)`
- **点击查询/重置/导出按钮**：
  - `await cdp.clickByBox(page, 'role:button[name="查询"]', guard)`
  - `await cdp.clickByBox(page, '.t-button:has-text("导出全部")', guard)`
- **获取当前页面全部交互控件（含 `cursor:pointer` 自定义下拉与复选框）**：
  - `const text = await cdp.snapshotText(page, guard, { interactiveOnly: true });`
