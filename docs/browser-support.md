# 连接器选择

本工具负责连接本机隔离的浏览器窗口，不负责选择业务页面中的操作流程。

- Edge 和 Chrome 共用 Chromium DevTools Protocol，但每个浏览器要分别启动、分别登录。
- 连接前由 lib/cdp/identity.js 核对本地监听地址、浏览器进程、调试端口、profile 和代理。
- 业务系统登录、二步验证和验证码默认由用户完成；调用方项目明确授权时，可使用项目规定的本机凭据流程。不读取、不复制日常 profile 的 Cookie。
- 陌生页面探索可以另选支持 CDP 的浏览器代理工具；固定流程再写成调用脚本或 Skill。
- Firefox、Safari 等不同引擎需要单独接入 Playwright 或 WebDriver。本版本不声称已经支持它们。
