# GcWebAuto 与 AgentBrowserBridge 对照

- 第一个：`C:\GkDesktop\GitProjects\GcWebAuto`（`gcwebauto` v0.5.0）
- 第二个：`C:\Users\juncheng.liu\Desktop\AgentBrowserBridge-CrossBrowser`（`agent-browser-bridge` v0.6.0）
- 结论：两边共用原生 CDP + `ws`。第二个保留 Edge 场景隔离与完整守卫原语；**0.6.0 已合并第一个的多 Agent 并发治理**（页面租约 + UI 短锁 + 专属工作页 + 反后台节流）。

## 1. 一句话定位

| 项目 | 定位 |
| --- | --- |
| GcWebAuto | 公司共享 Chrome 底座。正式库窄，仓里仍有大量个人/历史脚本。 |
| AgentBrowserBridge | 本机通用桥。Edge/Chrome 按场景隔离，完整守卫原语，业务逻辑外置到 Skill。 |

两者是同一条技术血统：实例身份校验、`fillNative`、`requireTarget`、隔离 `about:blank` smoke。第二个是把底座补成 Agent 能直接用的桥，不是换协议。

## 2. 能力对照（现行）

| 维度 | GcWebAuto | AgentBrowserBridge 0.6.0 |
| --- | --- | --- |
| 默认浏览器 | 启动器默认 Chrome | Edge / Chrome，默认 Edge |
| Profile | 默认 `C:\ChromeDebugProfile`；`-Scene` 可拆 | `%LOCALAPPDATA%\AgentBrowserBridge\profiles\<Browser>-<Scene>` |
| 日常浏览器 | 不接管日常 Profile | 默认拒绝日常 User Data |
| 守卫动作 | wait / fill / click / drag / key / select / auth | 同等，另保留桌面命名窗口 |
| 多 Agent 并发 | Target Lease + UI Mutex + withDedicatedTab | **已对齐**：`BROWSER_BRIDGE_LOCK_DIR` / `%LOCALAPPDATA%\AgentBrowserBridge\locks` |
| 反后台节流 | 启动器 3 项 Chromium 标志 | **已对齐** |
| 业务耦合 | 仓内仍有站点脚本 | 产品 API 不绑站点；K3Cloud 只在外部 Skill |
| 版本 | 0.5.0 / API 1 | 0.6.0 / API 1（新增 concurrency 导出） |

## 3. 多 Agent 不再打架（0.6.0）

问题：多个 Agent 同时点同一调试口时，会抢同一标签、互踢前台、后台标签被节流、`fillNative` 焦点断言失败。

解法（与 GcWebAuto 档位 M 一致，无守护进程）：

1. **Target Lease**：`acquireTargetLease({ targetId, port, ownerTag })`；冲突抛 `CDP_TARGET_LEASED`，不排队改同一页。
2. **UI Action Mutex**：`withUiLock`；`page.autoUiLock === true` 时 fill/clickByBox/drag/pressKey/screenshot/ensureWindowBounds 自动排队；超时抛 `CDP_UI_LOCK_TIMEOUT`。
3. **专属工作页**：`withDedicatedTab` 创建临时页、绑定租约、默认开 autoUiLock、结束后关页并释放租约。
4. **启动器**：`--disable-background-timer-throttling` 等 3 项，降低后台标签截图/坐标失败。

并发场景路由：

| 场景 | 策略 |
| --- | --- |
| 同站同账号写 | 业务层必须串行 |
| 不同站只读 | 各持 Target Lease，可不加 UI 锁并行 |
| 不同站含点击/输入/截图 | Target Lease + autoUiLock 排队 |
| 重度长任务 / 多账号 | 另开 `-Scene` 与端口物理隔离 |

## 4. 什么时候仍用 GcWebAuto

- 公司已批准的固定 Chrome L4 脚本、招聘出口门禁、双机 CI。
- 需要 GcDeskBridge 桌面侧车完整能力矩阵时看公司仓。

本机 Agent、K3Cloud、Edge、验证码、企微窗口、多 Agent 共享本机专用浏览器：用 AgentBrowserBridge。

## 5. 未测量项

没有对两个项目做同页同动作计时。机制上单次 CDP 同量级；墙钟差异主要来自少连错、少等人、少 Agent 回合。
