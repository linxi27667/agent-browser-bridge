# Agent Browser Bridge

A small local bridge that lets Codex connect to a dedicated Microsoft Edge or Google Chrome debug window.

It supports Edge and Chrome on Windows through the same Chromium DevTools Protocol. Default to a dedicated profile with `--remote-debugging-port`; that path does not show the Edge Allow prompt. Each connection is checked against its local debug port, browser type, profile folder, and proxy setting before page access.

## Start Edge

    pwsh -NoProfile -File .\lib\profile\Start-DebugBrowser.ps1 -Browser Edge -Port 9224

## Start Chrome

    pwsh -NoProfile -File .\lib\profile\Start-DebugBrowser.ps1 -Browser Chrome -Port 9222

If both are running at once, use different ports and different profile folders. The default profile folders are under %LOCALAPPDATA%\AgentBrowserBridge\profiles, outside this repository.

The first time, the dedicated-browser flow opens a fresh profile. Look up the site in the local Obsidian `密码簿.md`, sign in once in that window, and reuse the same profile later. The bridge never copies sign-in state or cookies from the daily browser.

`Connect-ExistingEdge.ps1` is a legacy attach for the daily Edge profile. It needs `edge://inspect/#remote-debugging` and may show “是否允许远程调试？” on every new browser WebSocket. Do not use it unless the user explicitly asks again.

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

check verifies the selected browser instance. smoke opens and closes a temporary about:blank page to check connection, unique selector wait, native click, Chinese input, DOM drag, Enter/Tab/Escape, select option, readback, captcha-image capture, and user-auth wait. `npm test` also clicks an isolated local desktop dialog through UI Automation.

Dedicated-profile smoke uses isolated `about:blank` pages only. Do not close the dedicated window after check/smoke.

## Browser support

| Browser | Connection | Sign-in state |
| --- | --- | --- |
| Microsoft Edge | Supported through local CDP on a dedicated profile | Dedicated profile by default; daily default profile is legacy and will prompt Allow |
| Google Chrome | Supported through local CDP | Separate dedicated profile |
| Chromium builds | Supported when their process is identifiable | Separate dedicated profile |
| Firefox / Safari | Not supported by this CDP bridge | Would need a separate Playwright/WebDriver connector |

## Safety

- The debug endpoint listens on 127.0.0.1 only.
- The bridge refuses an unexpected browser, port, profile, or proxy.
- Never attach to a normal daily browser profile unless the user explicitly asks again. Never copy cookies or commit profile data.
- Look up credentials in the local Obsidian password book. If missing, ask the user and write the entry there. Never print or save credentials in Git. Optional `captureUniquePng` is for reading a unique image, not for a third-party solver.
- Optional desktop clicks (`invokeNamedButton`) need an explicit button name. Window-level helpers (`focusNamedWindow`, `sendKeysToNamedWindow`, `captureNamedWindow`) need an exact window title. They do not close windows (Alt+F4 is refused).
- A CDP debug port grants control of that dedicated browser to local software. Close the dedicated window when finished.
- This project does not bypass site controls, authentication, or approval rules.
