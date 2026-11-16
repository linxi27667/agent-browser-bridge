# 浏览器与桌面统一自动化使用说明

本项目保留两套执行引擎：Node.js/CDP 负责网页，Rust `agent-desktop` 负责操作系统无障碍控件。统一入口负责路由、执行模式、步骤验收与错误报告，不把两种元素引用或实现语言强行合并。本机这次适配不等于已合入公司环境的所有历史改动。

## 1. 选择执行路线

| 任务 | 优先方式 | 切换条件 |
| --- | --- | --- |
| 查询数据、运行程序、处理文件 | 已有 API / CLI / 文件接口 | 接口确实不能满足当前任务时，再进入 UI |
| 网页查询、填写与页面验收 | 专用 Edge/Chrome 的 CDP 桥接 | 原生文件框等网页之外的控件，交给桌面后端 |
| 原生按钮、文本框、窗口 | `agent-desktop` 无障碍接口 | 树已就绪、范围正确，仍无可用语义能力时才评估物理输入 |
| 自绘 UI、画布等 | 截图观察，必要时物理输入 | 进入 exclusive 模式，并确认目标与结果 |

`route` 只给出推荐，不启动应用、不读取文件内容、不执行推荐动作。浏览器 DOM 引用与桌面 UIA 引用始终保留自己的格式，不能互换。

## 2. 环境与入口

需要 Node.js 22 或更新版本。桌面后端单独安装；例如固定集成版本：

```powershell
npm install -g agent-desktop@1.3.1
node cli/agent.cjs --help
node cli/agent.cjs doctor --expected-version 1.3.1
```

也可用 `npm run agent -- <命令>`。二进制不在自动发现的位置时，用仓库外的环境配置指定 `AGENT_DESKTOP_BIN`，或给本次 CLI 传 `--binary <绝对路径>`。原生状态目录可通过 `desktopHome` / `AGENT_DESKTOP_HOME` 分离；保持目录归当前运行用户所有。不要把本机安装路径、浏览器配置目录或口令写入提交文件。

统一 CLI 默认读取仓库外的 `%LOCALAPPDATA%\AgentBrowserBridge\automation.json`；也可用 `--config <路径>` 指定。非 Windows 的默认位置为用户目录下 `.config/agent-browser-bridge/automation.json`。配置仅接收连接字段：`desktop.binaryPath`、`desktop.expectedVersion`、`desktop.desktopHome`，以及 `browser.endpoint`、`browser.profile`、`browser.browser`、`browser.proxy`；不能在配置中默认开启写入或 exclusive。显式 CLI 参数优先于对应环境变量，环境变量优先于本地配置。

`doctor` 检查运行环境与桌面后端版本，不枚举用户窗口，不读剪贴板，不采集业务快照，不为检查而启动或附加默认浏览器。后端不可用会报告缺失，不会悄悄改用物理输入。

浏览器任务沿用严格身份配置：`CDP_HTTP`、`BROWSER_BRIDGE_REQUIRE_INSTANCE`、`BROWSER_BRIDGE_EXPECT_PROFILE`、`BROWSER_BRIDGE_EXPECT_PROXY`、`BROWSER_BRIDGE_EXPECT_BROWSER`。配置必须对应显式选中的本机专用实例；不能把公司电脑的路径、端口或版本直接照抄到另一台机器。

```powershell
node cli/agent.cjs route --url https://example.com
node cli/agent.cjs route --app notepad.exe
node cli/agent.cjs route --file .\export.csv
node cli/agent.cjs browser scenes
node cli/agent.cjs --scene k3 browser tabs
node cli/agent.cjs --scene k3 browser snap --url k3cloud
node cli/agent.cjs --write --scene k3 browser hover-click ".todo-list li" "button.destroy"
node cli/agent.cjs desktop capabilities --app notepad.exe
node cli/agent.cjs --write --mode exclusive desktop ensure-ready --app notepad.exe
node cli/agent.cjs --write desktop deliver --stdin
node cli/agent.cjs --write --mode exclusive desktop batch --stdin
node cli/agent.cjs run --file .\reviewed-workflow.cjs
```

## 3. 执行模式与只读限制

默认是 `readOnly: true`、`mode: 'cooperative'`。`--write` 对应 `readOnly: false`；`--mode exclusive` 允许已知会影响共享前台资源的命令。两者是独立开关，exclusive 不会自动允许写入。

| 能力 | 默认只读 cooperative | 允许写的 cooperative | 允许写的 exclusive |
| --- | --- | --- | --- |
| 版本、状态、目标快照、属性读取 | 允许 | 允许 | 允许 |
| 语义点击、`set-value` 等变更 | 拒绝 | 允许支持的操作 | 允许支持的操作 |
| 桌面 `type`、`press`、物理鼠标、主动聚焦或恢复窗口 | 拒绝 | 拒绝 | 允许支持的操作 |
| 剪贴板写入、启动/关闭应用 | 拒绝 | 拒绝 | 允许支持的操作 |
| 未知命令、任意 batch/mcp/sandbox 转发 | 拒绝 | 拒绝 | 拒绝 |

浏览器页内 `pressKey('Enter'|'Tab'|'Escape', guard)` 与 `hover(selector, guard)` 通过 CDP 只发送到租约页面，允许在可写 cooperative 模式下执行，并使用端口锁串行。它们不发送 Windows 全局按键、不移动系统鼠标；桌面 `adPress` 仍需 exclusive。截图等可能激活目标的操作需要 exclusive；应用自己的弹窗也可能影响前台。

合作模式限制本入口已知的操作路径，不是操作系统隔离。exclusive 工作流锁只协调参与此桥接的进程，不能阻止人或其他工具输入，不能代替浏览器页签租约与同站同账号的业务串行。

开关不扩大任务授权：允许写入并不代表可以替用户发送消息、修改任意单据或关闭无关应用。不要在被拒绝后调用原始 CLI 或旧 PowerShell 函数绕过限制。

## 4. 桌面 JavaScript 调用迁移

```js
const { createDesktopClient } = require('./lib/desktop/agentDesktop');
const desktop = createDesktopClient({
  readOnly: true,
  mode: 'cooperative',
  expectedVersion: '1.3.1',
  timeoutMs: 30000,
});
const snapshot = await desktop.adSnapshot('notepad.exe');
console.log(snapshot.ref_count);
```

配置包括 `mode`、`readOnly`、`binaryPath`、`expectedVersion`、`desktopHome`、`timeoutMs`、`maxOutputBytes`、`signal`。客户端和模块顶层的 `ad*` 方法都返回 Promise；旧 `cli/run.cjs` 的调用也必须加 `await`。异步子进程允许 Node 继续处理浏览器租约续期，避免被同步桌面命令阻塞。

`timeoutMs` 限制后端子进程或租约等待，不是任意可信 JavaScript 的全局强制截止时间。`adSnapshot` 的 `nativeTimeoutMs` 单独控制原生树遍历时限；调用方可以让宿主超时比原生遍历预算略长。自定义 action / verifier 应使用 `signal` 并自行保证有界等待；无限循环或永不结束的 Promise 不能由文档约束安全终止。

文本赋值优先用 `adSetValue`。业务允许修改后，创建 `readOnly: false` 的客户端，把刚观察到的完整引用传给 `adSetValue(ref, text)`。文本经 stdin 传给子进程，不作为命令参数；不要把正文、口令或剪贴板内容加入错误报告。

桌面引用如 `'@sabc:e1'` 归属于某次快照，示例引用不能直接当实际目标。PowerShell 中引用必须加单引号。浏览器 `@e1` 只在浏览器快照上下文有效。观察不完整、目标歧义、进程重启或 `STALE_REF` 都需要重新确认，不能盲用旧引用。

`adRaw(args, options)` 只转发已支持且参数通过校验的命令，遵守同一策略，不是任意子进程执行器。`--force` 等绕过选项不受支持。坐标点击另需 `windowId`，并检查窗口当前聚焦及坐标位于其范围内；检查与输入之间仍有状态变化窗口，不能把它等同于语义引用的重新标识保证。

坐标输入的 JavaScript 形式是 `adMouseClick(x, y, {windowId})`；CLI 用任务选项 `--target-window w-...` 传递预检窗口，不把它作为原生 `mouse-click` 参数。两种形式都需要明确的可写 exclusive 任务。

最小化窗口先用 `adRestoreWindow(undefined, {windowId})` 恢复，再通过 `adListWindows()` 确认 `minimized: false` 与实际焦点；不要把任务栏按钮成功返回当作恢复证明，也不要反复点击导致窗口再次最小化。`adOpenSystemSurface(surface)` 支持 `taskbar`、`system-tray`、`system-tray-overflow`、`start-menu`、`action-center`，同样需要可写 exclusive；读取这些区域可用 `adSnapshot(undefined, {surface})`。普通窗口快照仍须明确应用、窗口 ID 或根引用。

### 4.1 能力快速识别、受约束批量与通用场景层

- **能力快速识别（`adInspectCapabilities`）**：面对陌生桌面窗口时，先调 `await desktop.adInspectCapabilities('Weixin.exe', { preferFocused: true })`（或 `node cli/agent.cjs desktop capabilities --app Weixin.exe`）。返回 `minimized_unobservable`、`uia_semantic`（自动将只读/禁用文本框分离至 `readOnlyEditableRefs`，仅将真正可写输入框放入 `editableRefs`）或 `custom_ui_visual`（0 个可用客户区控件或仅剩标题栏最小化/最大化/关闭按钮）。一旦判定为 `custom_ui_visual`，立即切换受控视觉路线，不再反复轮询 `find`/`snapshot`。
- **受约束原生批量（`adBatch`）**：`await desktop.adBatch(steps, { windowId })`（或 `node cli/agent.cjs --write --mode exclusive desktop batch --stdin`）逐项校验白名单、只读/独占策略与坐标窗口预检。当桌面运行时支持 `batch --stdin`（`1.3.2-dev` 及以上）时单次进程完成全部动作与回读；在 `1.3.1` 上自动降级为安全分段执行，确保任何输入文本绝不进入进程命令行参数，且返回结果自动脱敏写入字段。`adRaw(['batch', ...])` 保持拦截。
- **通用窗口就绪与多消息核验投递（`scenes`）**：工作流上下文注入 `scenes.ensureWindowReady(desktop, target, options)`（自动恢复最小化、通过 `Explorer ShellExecute` 脱离短命进程树启动 `.exe`、针对微信 4.x 登录弹窗自动回车/校验 `"进入微信"` 或报错 `WECHAT_LOGIN_REQUIRED`、通过 `AttachThreadInput` 辅助解锁 Windows 前台锁、聚焦并校验窗口尺寸非折叠；若检测到当前进程运行在非交互隔离桌面如 `exebox-*`，立即抛出 `DESKTOP_SANDBOX_ISOLATED` 明确提示切回 `WinSta0\Default`）与 `scenes.deliverMessagesVerified(desktop, spec, messages, options)`（支持 `uia_semantic` 单批 `set-value + get + click` 与 `custom_ui_visual` 单批帧哈希变化核验；任何回读不符或提交异常立即停止并标记 `retry: 'unsafe'`，零自动重发）。
- **自绘窗口原生 OCR、应用唤醒、无感波纹点击与富媒体会话投递（企业微信/微信/QQ/飞书/钉钉）**：
  - 应用注册表与托盘唤醒：`desktop apps`、`desktop windows`、`--write --mode exclusive desktop open-app --app wecom`（严格隔离 `wechat` 与 `WXWork.exe` 同开误命中，内置中英文别名发现注册表/运行进程/常见目录，经 Explorer COM / Breakaway 拉起脱离进程树并在托盘唤醒时忽略阴影小弹窗）。
  - 零依赖后台区域 OCR：`desktop ocr --app WXWork.exe --region header|sidebar|messages|composer|full --match "文件传输助手"`（基于系统内置 `.NET Framework csc.exe` + `Windows.Media.Ocr`，后台 `PrintWindow` 抓图不抢焦点，支持 2x 双三次放大、中文分词去空格、Windows OCR 常见偏旁拆字折叠如 `文亻牛`/`文亻制专` 及 4~8 字词距 `<=1` 防近似字误识）。
  - 无感波纹与文本定位点击 / 富媒体核验投递：`desktop click-text --app WXWork.exe --text "文件传输助手" --region sidebar`（坐标点击默认开启穿透蓝色波纹 `ripple:true`、人机防冲突检测与 18ms 光标瞬移归位 `restoreCursor:true`，可选 `clickMode:'message'` 发送窗口消息或 `adCursorOverlay('enable'|'disable')`）；`--write --mode exclusive desktop chat-send --stdin`（支持 `navigationMode:'auto'|'keyboard_first'` 零动鼠全键盘搜索直达；先校验顶部标题栏 OCR，不匹配时自动侧栏 OCR 点击或 `Ctrl+F` 搜索切换；发送前强制通过 `CHAT_TARGET_UNVERIFIED` 标题硬门禁，未命中目标会话绝不发送任何内容；单批 `adBatch` 支持混合投递 `text`、内联图片 `image`（`.png`/`.jpg`/`.bmp` 自动转 `CF_DIB+PNG`）、动图表情包 `sticker`（`.gif` 走 `CF_HDROP` `clipboard-set --file-url`）与普通附件 `file`，内置剪贴板异步解码节流等待，投递后核对窗口帧哈希与消息区 OCR）。
- **单锁悬停点击（`page.hoverAndClick`）**：针对 CSS `:hover` 才显现的行内操作按钮（如 TodoMVC `.destroy`），使用 `await page.hoverAndClick(hoverSelector, clickSelector, guard)` 或 `abb hover-click`，在同一端口 UI 锁内完成悬停与点击。

## 5. 工作流与验收

`run --file` 加载已审阅的 CommonJS 文件。文件导出异步函数，接收 `desktop`、`browser`、`step`、`signal`。以下示例只检查后端版本：

```js
// reviewed-workflow.cjs
module.exports = async function ({ desktop, step }) {
  await step(
    '核对桌面后端版本',
    () => desktop.adVersion(),
    value => value.version === '1.3.1',
  );
};
```

```powershell
node cli/agent.cjs run --file .\reviewed-workflow.cjs --expected-version 1.3.1
```

也可从自己的 Node 程序直接调用：

```js
const { runWorkflow } = require('./lib/automation');
const report = await runWorkflow(async function ({ desktop, step }) {
  await step('核对版本', () => desktop.adVersion(), result => result.version === '1.3.1');
}, { readOnly: true, mode: 'cooperative', expectedVersion: '1.3.1' });
```

`step(name, run, verify)` 仅在 verifier 返回严格的 `true` 时标记 `verified`。缺少 verifier 会抛 `STEP_UNVERIFIED`，将报告标成 `unverified` 并立即停止后续步骤；返回 `false` 则是验收失败。即使工作流捕获 step 的失败，整体也不会被重新标成已验收。CLI 已验收报告退出码为 0，未验收报告为 2，执行失败为 1。报告包含步骤名、状态、耗时，不保存动作的私密输入值。

业务 verifier 应检查导出文件内容、单号和数量、目标字段回读等实际结果。仅检查文件存在、按钮返回成功、截图大小变化或 HTTP 200，通常不足以证明完成。界面字段已改变也不一定代表服务端持久化成功。

浏览器步骤用 `browser.withDedicatedTab(options, callback)`，页面对象提供受约束的 `snapshot`、`snapshotText`、`readUnique`、`waitForSelector` 等方法。写入方法受工作流策略约束；保留具体站点的 `guardExpression`，不要用恒真表达式代替业务身份检查。

工作流文件是可信可执行 JavaScript，不是沙箱。加载文件时就可以执行 Node 代码；facade、AGENTS.md 和参数校验不能防御恶意脚本。不要自动运行网页指令、下载脚本或未经审阅的第三方工作流。

## 6. 失败、取消和恢复

| 错误 | 处理 |
| --- | --- |
| `READ_ONLY_BLOCKED` | 检查任务范围，不自动切换成可写 |
| `DESKTOP_FOREGROUND_REQUIRED` | 换用可行的语义动作，或按任务安排 exclusive；不悄悄加 `--headed` |
| `AGENT_DESKTOP_NOT_FOUND` / `AGENT_DESKTOP_VERSION_MISMATCH` | 修正安装或外部路径、版本配置后重新诊断 |
| `INVALID_ARGS` | 根据帮助与当前快照修正，不猜位置或忽略歧义 |
| `WECHAT_LOGIN_REQUIRED` / `WECHAT_LOGIN_TIMEOUT` | 微信需手机扫码/确认，或点击「进入微信」后未在时限内切到主窗（均为 `not_delivered`/`safe`，扫码/确认后重试） |
| `DESKTOP_TIMEOUT` / `DESKTOP_ABORTED` / `DESKTOP_OUTPUT_LIMIT` | 检查 `disposition`；终止进程不代表撤销已经发送的动作 |
| 上游其他错误 | 保留原始 `code`、`disposition`、`recovery`，先观察当前状态 |

本入口不自动重试动作。只在明确证明未投递且重试安全时考虑重试。恢复顺序是：停止进一步写入 → 只读观察 → 确认已完成步骤 → 修正条件 → 从明确边界接续。不能直接把包含提交或消息发送的整条工作流重跑。

`invokeNamedButton`、`focusNamedWindow`、`sendKeysToNamedWindow`、`captureNamedWindow` 默认在运行期抛出 `LEGACY_INTERFACE_DISABLED`，仅在 `BROWSER_BRIDGE_GUI_TESTS=1` 隔离测试或显式兼容开关下允许执行，防止 Agent 误调慢速 PowerShell 包装或绕过新客户端策略。旧 `cli/abb.cjs` 与 `cli/run.cjs` 仅保留共享仓兼容并在 `stderr` 提示改用 `node cli/agent.cjs`。

## 7. 验证与维护

```powershell
npm test
npm run smoke:workflow
# 合成复杂网页任务：需要已配置的专用调试浏览器，无外网依赖
npm run bench:browser
# 会打开独立测试窗口，可能取得前台焦点：
npm run test:desktop
```

普通回归不启用可见桌面 fixture；显式 GUI 测试通过 `BROWSER_BRIDGE_GUI_TESTS=1` 开启。组合 smoke 使用隔离 fixture、没有物理输入。浏览器实测只操作隔离 `about:blank`，不读或提交业务系统，不关闭用户浏览器。报告分别列模拟测试、真实后端检查和真实应用验收，不把一个窗口通过推导成所有软件通过。

共享文件指纹清单仍由同步脚本生成。本机没有公司共享仓时，只能检查或更新本仓清单，不能宣称已完成双仓同步。升级桌面后端时，先修改固定版本预期，重跑契约回归与隔离 smoke，再验收受影响的实际应用。

本阶段不承诺自动从任意业务断点恢复，也不承诺消除所有前台干扰。验收重点是：路由明确、默认只读、已知前台操作可控、结果有证据、未知投递不盲重试。

## 8. 2026-11-15 本机隔离验收实例

以下是 Windows 本机实测实例，不是通用默认路径：

- 桥接版本：`0.8.0`；桌面后端：`1.3.1`。
- 固定二进制目录：`<TOOLS_DIR>\AgentDesktop\1.3.1\`，复制后核对了 SHA-256；实际可执行文件以本机配置的 `desktop.binaryPath` 为准。
- 本机配置：`%LOCALAPPDATA%\AgentBrowserBridge\automation.json`。
- 原生状态目录：`%LOCALAPPDATA%\AgentBrowserBridge\desktop-state-v1`，由当前用户持有且使用严格 ACL，避免复用不兼容的旧状态目录。

检查本机配置指向的二进制，再运行统一诊断和组合验收：

```powershell
$config = Get-Content -LiteralPath "$env:LOCALAPPDATA\AgentBrowserBridge\automation.json" -Raw | ConvertFrom-Json
Get-FileHash -LiteralPath $config.desktop.binaryPath -Algorithm SHA256
npm run doctor
npm run smoke:workflow
```

当次 `doctor` 的桌面后端 `available` 与 `ready` 均为 `true`。组合验收仅使用自己的隔离 `about:blank` 和不主动激活的 WinForms 测试窗，四步分别验证：

1. 网页语义写入并回读中文、引号和元字符。
2. 写出本地结果文件，再独立读取并核对文本与数量 `37`。
3. 按精确窗口 ID 采集原生控件树，并确认目标文本框唯一。
4. 对文本框语义赋值并回读，与网页和文件结果一致。

四步均为 `verified`，原生赋值报告 `delivered_verified`，使用 `cooperative` 模式，物理输入命令数为 `0`。该次核心工作流耗时为 `1386ms`；它不包含所有启动准备耗时，也不表示其他应用或业务流程能达到相同速度。

本机原始报告在 `artifacts/workflow-smoke/run-lVkNAN/report.json`。`artifacts/` 为忽略的运行产物，报告不随 Git 分发；换机后用相同命令生成新报告。该结果证明两套后端和文件步骤能在隔离场景闭环，未对微信、金蝶或税务业务进行正式验收。

## 9. 复杂网页基准与真实应用测试的区别

`npm run bench:browser` 使用已配置的专用调试浏览器，新建自己的 `about:blank`，装入仓内 `tests/fixtures/luna-browser-benchmark.html`。该页面只有合成数据，模拟 160ms 异步查询，无外网依赖；不会操作既有业务标签。动作全部经过可写 cooperative 工作流，准备 fixture 的原始 CDP 操作只限该自建页面。

每轮包含 23 个验收步骤、15 次改变页面状态的交互：填写中文、筛选、排序并核对首行、分页勾选、核对确认弹窗、生成批次、读取 CSV。独立数据校验确认 4 单、9 件、1768 元。报告写入被忽略的 `artifacts/luna-browser-benchmark/report.json`；结束时只关闭自己创建且仍是 `about:blank` 的页面。

2026年11月15日本机由 Luna Agent 执行的最终三轮均为 23/23 `verified`，0 失败；冷准备 1616ms，三轮脚本执行分别为 571/967/986ms，轮间 fixture 重置为 0/7/8ms。执行时间包含动作与验收，不包含 Agent 阅读、编写、审查和修复所用的墙钟时间，也不能推导有外网、登录或复杂业务系统的速度。

同日还在公开 TodoMVC 示例页完成创建、勾选、筛选与逐项删除，最终独立读取确认为 0 条，HTTP 标签保留。首次探测到独立空列表回读约 19 分 41 秒，含 9 次失败或未验收的工作流尝试、1 次只读探针错误及一次修复前的模式停步。原因包括错误选择器、隐藏行仍出现在快照中而导致筛选断言不适用、删除按钮需要悬停；修正后从已观察状态接续，未自动重试。最后的清理工作流 7/7 verified、15192ms，包含三次各约 5 秒的删除，不是整个探索任务耗时。真实微信的自绘界面在本机未提供有效 UIA 控件；该类任务需要额外定位与前台协调，应与合成网页成绩分别记录。
