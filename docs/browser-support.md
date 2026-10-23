# 连接器选择

本工具负责连接本机浏览器窗口，不负责选择业务页面中的操作流程。默认使用隔离 profile；仅在用户明确指定和授权时，连接已经登录的普通 Edge。

- Edge 和 Chrome 共用 Chromium DevTools Protocol。专用 profile 需分别登录；现有 Edge 会话模式直接继承用户已经登录的 profile，不复制 Cookie。
- 连接前由 lib/cdp/identity.js 核对本地监听地址、浏览器进程、调试端口、profile 和代理；现有 Edge 模式还要核对 `DevToolsActivePort` 与浏览器 WebSocket 身份。
- 页面操作必须带上下文守卫：`waitForSelector`、`fillNative`、`clickNative`/`clickByBox`、`readUnique`。
- 登录和验证码默认由用户在可见窗口完成：`inspectAuth` / `waitForUserAuth` 等待遮罩消失；`captureUniquePng` 只截取唯一节点，供调用方阅读。不保存密码，不调用第三方打码。
- 可选桌面控制：`lib/desktop/invokeNamedButton.js` 点击当前用户会话里指定名称的按钮，建议同时给出窗口标题。Cursor Computer Use 只作为智能体会话里的视觉兜底。
- 连接现有 Edge 时运行 `lib/profile/Connect-ExistingEdge.ps1`。用户先在 `edge://inspect/#remote-debugging` 勾选允许远程调试；`/json/version` 返回 404 是 Edge 156 默认 profile 的正常现象。脚本读取 `DevToolsActivePort`，连接 browser WebSocket，用 `Target.attachToTarget` 操作页面。弹出授权时点“允许”。不要给默认 profile 加 `--remote-debugging-port` 反复重启。专用 profile 仍用 `lib/profile/Start-DebugBrowser.ps1`，需要单独登录。
- 现有 profile 的会话数据可被本机自动化进程访问；只访问用户点名的站点和页面，不读取无关标签页。业务系统登录、二步验证和验证码仍由用户处理；桥接只负责检测、等待和按需截图。
- 陌生页面探索可以另选支持 CDP 的浏览器代理工具；固定流程再写成调用脚本或 Skill。
- Firefox、Safari 等不同引擎需要单独接入 Playwright 或 WebDriver。本版本不声称已经支持它们。
