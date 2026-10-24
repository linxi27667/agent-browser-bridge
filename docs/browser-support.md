# 连接器选择

本工具负责连接本机浏览器窗口，不负责选择业务页面中的操作流程。默认使用专用调试窗口（`--remote-debugging-port` + 独立 `--user-data-dir`），不弹“是否允许远程调试？”。日常默认 Edge 只在用户再次明确要求时才附加。

- Edge 和 Chrome 共用 Chromium DevTools Protocol。专用 profile 各自登录一次；不从日常浏览器复制 Cookie。
- 连接前由 lib/cdp/identity.js 核对本地监听地址、浏览器进程、调试端口、profile 和代理。
- 页面操作必须带上下文守卫：`waitForSelector`、`fillNative`、`clickNative`/`clickByBox`、`readUnique`。
- 登录先查 Obsidian 知识库根目录 `密码簿.md`，按网站/主机匹配条目填写专用窗口。找不到就问用户，再写入密码簿。验证码仍可用 `inspectAuth` / `waitForUserAuth` / `captureUniquePng`。不把密码写进 Git、命令行或回复，不调用第三方打码。
- 可选桌面控制：`lib/desktop/invokeNamedButton.js` 点击当前用户会话里指定名称的按钮，建议同时给出窗口标题。Cursor Computer Use 只作为智能体会话里的视觉兜底。
- 专用窗口入口：`lib/profile/Start-DebugBrowser.ps1`。已在运行则复用同一配置目录和端口。日常 Edge 的 `Connect-ExistingEdge.ps1` 是遗留路径，每次新 WebSocket 都可能再弹允许框。
- 只访问用户点名的站点和页面，不读取无关标签页。
- Firefox、Safari 等不同引擎需要单独接入 Playwright 或 WebDriver。本版本不声称已经支持它们。
