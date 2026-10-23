# Agent Browser Bridge

A small local bridge that lets Codex connect to a dedicated Microsoft Edge/Google Chrome window, or to an explicitly authorized existing Microsoft Edge session.

It supports Edge and Chrome on Windows through the same Chromium DevTools Protocol. Each browser connection is checked against its local debug port, browser type, profile folder, and proxy setting before page access.

## Start Edge

    pwsh -NoProfile -File .\lib\profile\Start-DebugBrowser.ps1 -Browser Edge -Port 9224

## Start Chrome

    pwsh -NoProfile -File .\lib\profile\Start-DebugBrowser.ps1 -Browser Chrome -Port 9222

If both are running at once, use different ports and different profile folders. The default profile folders are under %LOCALAPPDATA%\AgentBrowserBridge\profiles, outside this repository.

The first time, the dedicated-browser flow opens a fresh profile. Sign in in that window, or use a locally authorized sign-in procedure from the calling project. The bridge never copies sign-in state or cookies between profiles.

## Connect to the user's existing Edge session

Use this only when the user explicitly asks to reuse the Edge window they already have open. This inherits that profile's logged-in session and browser data, so subsequent page access must be limited to the exact user-requested site and tab.

    pwsh -NoProfile -File .\lib\profile\Connect-ExistingEdge.ps1

The launcher waits for Edge's “是否允许远程调试？” prompt and clicks 允许 in the current user session. You can still click it yourself.

The script attaches to a running default Edge profile after the user enables `edge://inspect/#remote-debugging`. Newer Edge/Chromium builds keep `/json/version` at 404 on the default profile; that is expected. The bridge reads `DevToolsActivePort`, connects to the browser WebSocket, and drives pages with `Target.attachToTarget`. Click Allow if Edge prompts. Do not restart the default profile with `--remote-debugging-port`. The dedicated-profile origin (`http://agent-browser-bridge.invalid`) stays on the isolated launcher only.

The existing-session mode is Windows-only and limited to the default Edge User Data directory. It verifies the loopback listener owner, Edge executable, active port file, default profile, and proxy flags, then confirms browser identity over the WebSocket. If the policy `RemoteDebuggingAllowed` is disabled, the script stops without changing policy.

## Install and verify

Requires Node.js 22 or newer.

    npm ci --ignore-scripts
    npm test

The launcher prints the local CDP address. Set the same values before using the CLI:

    $env:CDP_HTTP = 'http://127.0.0.1:9224'
    $env:BROWSER_BRIDGE_REQUIRE_INSTANCE = '1'
    $env:BROWSER_BRIDGE_EXPECT_PROFILE = "$env:LOCALAPPDATA\AgentBrowserBridge\profiles\Edge-default"
    $env:BROWSER_BRIDGE_EXPECT_PROXY = 'none'
    $env:BROWSER_BRIDGE_EXPECT_BROWSER = 'edge'
    npm run check
    npm run smoke

For Chrome, use port 9222, the Chrome-default profile, and chrome for BROWSER_BRIDGE_EXPECT_BROWSER.

check verifies the selected browser instance. smoke opens and closes a temporary about:blank page to check connection, unique selector wait, native click, Chinese input, readback, captcha-image capture, and user-auth wait. `npm test` also clicks an isolated local desktop dialog through UI Automation.

To verify the existing Edge session with both this bridge and Playwright on the same browser WebSocket:

    pwsh -NoProfile -File .\lib\profile\Connect-ExistingEdge.ps1
    npm run verify:combined

`verify:combined` only uses isolated `about:blank` pages. It does not close the daily Edge window. Official Chrome DevTools MCP is optional and still cannot use `/json/version` on Edge 156 default profiles.

## Browser support

| Browser | Connection | Sign-in state |
| --- | --- | --- |
| Microsoft Edge | Supported through local CDP; explicit existing-session attach on Windows | Dedicated profile by default; existing default profile only with explicit user authorization and the bridge launcher's loopback and origin restrictions |
| Google Chrome | Supported through local CDP | Separate dedicated profile |
| Chromium builds | Supported when their process is identifiable | Separate dedicated profile |
| Firefox / Safari | Not supported by this CDP bridge | Would need a separate Playwright/WebDriver connector |

## Safety

- The debug endpoint listens on 127.0.0.1 only.
- The bridge refuses an unexpected browser, port, profile, or proxy.
- Never attach to a normal daily browser profile without explicit user authorization. Existing-profile mode inherits its active session; never copy cookies or commit profile data.
- Complete sign-in and captcha in the visible browser window, or through a local credential procedure explicitly authorized by the calling project. Never print or save credentials. Optional `captureUniquePng` is for reading a unique image, not for a third-party solver.
- Optional desktop clicks (`invokeNamedButton`) are limited to an explicit button name in the current user session.
- A CDP debug port grants control of that dedicated browser to local software. Close the dedicated window when finished.
- This project does not bypass site controls, authentication, or approval rules.
