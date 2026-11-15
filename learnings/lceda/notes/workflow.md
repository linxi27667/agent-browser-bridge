# 嘉立创EDA专业版 (`pro.lceda.cn`) 防休眠桥接与插件自愈规范

## 一、后台休眠断线根因与根治参数

`easyeda-agent` 连接器扩展（`EDA Agent Connector`）通过 `eda.sys_WebSocket` 连接本机 `ws://127.0.0.1:60832/eda`，并以 `3000ms` 周期发送心跳（宿主空闲约 5 秒即断开 WebSocket）。在用户日常默认 Edge 中，后台标签页会被 Chromium 遮挡计算、密集唤醒节流与 Edge 效率/休眠标签页机制彻底冻结，导致 `easyeda health` 退化为 `windows: []`。

`lib/profile/Start-DebugBrowser.ps1` 已固化以下防休眠与本地网络免弹窗启动参数：

- `--disable-background-timer-throttling`
- `--disable-backgrounding-occluded-windows`
- `--disable-renderer-backgrounding`
- `--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,msEdgeSleepingTabs,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests`

在此专用调试实例中，即使 `pro.lceda.cn/editor` 处于后台（`pageVisibility: "hidden"`），心跳 `lastSeen` 仍每 3 秒稳定推进，不会休眠断连。

## 二、Edge 157 双重权限提示处理 (`edge://permission-request-dialog/`)

首次在未加 `LocalNetworkAccessChecks` 禁用参数的 Edge 实例中打开 `https://pro.lceda.cn/editor` 时，Edge 157 会分两次挂出独立 CDP Target `edge://permission-request-dialog/`（仅在该标签页置于前台 `Target.activateTarget` 时挂载到 `/json/list`）：

1. **本地字体权限**（`localFonts`）：页面初始化阶段请求访问本机字体。
2. **本地网络访问权限**（`localNetworkAccess`）：HTTPS 页面首次向 `ws://127.0.0.1:60832/eda` 发起连接时拦截阻塞。

自动化双保险处置：
- **事前授权**：连接 Browser CDP 后直接执行 `Browser.grantPermissions` 授予 `origin: "https://pro.lceda.cn"` 的 `["localNetworkAccess", "localFonts"]`。
- **弹窗兜底**：激活目标标签页等待 `600ms` 后扫描 `url.includes("permission-request-dialog")` 的 Target，穿透 `<fluent-button>` Shadow DOM 点击 `允许`。

## 三、静默导入 `.eext` 连接器与开启「允许外部交互」

无需弹出 Windows 系统文件选择框，全流程基于 CDP 与语义定位器幂等完成：

1. **前置幂等检查**：读取 `pro.lceda.cn` IndexedDB（`User_*_v6` -> `extensions`），若 `uuid === "4dae27407c1d43be98e8e210d45fe587"`（`EDA Agent Connector`）已存在且 `isEnable === true`、`isAllowExternalInteractions === true`，直接跳过导入，零 UI 扰动。
2. **登录态处理**：若 `#login-btn` 可见，通过可信鼠标事件（`clickByBox`）点击触发 `passport.jlc.com` SSO 自动登录；若无 SSO Cookie 需人工扫码/滑块，则明确返回 `manualLoginRequired: true`，绝不盲猜口令。
3. **静默导入 `.eext`**：
   - 点击顶部栏 `高级`（`--keep-hover`）-> `扩展管理器(E)...`；
   - 对隐藏文件控件 `button[data-test="Import"] input[type="file"]` 调用 `DOM.setFileInputFiles` 注入本机 `easyeda-agent-connector_v1.14.0.eext`；
   - 在 `安全提示` 弹窗点击 `确认`；
   - 切到 `已安装` 页签 -> 选中 `EDA Agent Connector` -> 确保状态为 `已启用` -> 切到 `配置` 页签 -> 勾选 `input[data-test="Allow interactive with external"]`（允许外部交互）与 `input[data-test="Show at header menu"]`（显示在顶部菜单）-> 关闭弹窗并刷新使 `eda.sys_WebSocket` 生效。

## 四、标准一键自愈命令

```powershell
# 一键检查并自愈（已连接时 50ms 幂等无损返回；断连时自动拉起/唤醒/导入/重连）
node cli/abb.cjs --scene lceda lceda ensure

# 指定校验或打开目标工程 UUID（仅在尚无窗口持有该工程时安全打开，防止双窗口保存冲突）
node cli/abb.cjs --scene lceda lceda ensure --project-uuid <PROJECT_UUID>

# 仅查看 daemon + 浏览器登录态 + 扩展配置状态（纯只读）
node cli/abb.cjs --scene lceda lceda status

# 在不刷新页面的前提下通过顶部菜单 EDA Agent -> Reconnect 软重连
node cli/abb.cjs --scene lceda lceda reconnect

# 显式导入或升级指定 .eext 插件包
node cli/abb.cjs --scene lceda lceda import-ext --eext "C:\Users\juncheng.liu\Desktop\Easyeda_Agent\extensions\easyeda-agent-connector_v1.14.0.eext"
```
