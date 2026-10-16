# Agent Browser Bridge

A small local bridge that lets Codex connect to a dedicated Microsoft Edge or Google Chrome window.

It supports Edge and Chrome on Windows through the same Chromium DevTools Protocol. Each browser connection is checked against its local debug port, browser type, profile folder, and proxy setting before page access.

## Start Edge

    pwsh -NoProfile -File .\lib\profile\Start-DebugBrowser.ps1 -Browser Edge -Port 9224

## Start Chrome

    pwsh -NoProfile -File .\lib\profile\Start-DebugBrowser.ps1 -Browser Chrome -Port 9222

If both are running at once, use different ports and different profile folders. The default profile folders are under %LOCALAPPDATA%\AgentBrowserBridge\profiles, outside this repository.

The first time, the browser opens a fresh dedicated profile. Sign in in that window, or use a locally authorized sign-in procedure from the calling project. The bridge never copies sign-in state from a normal Edge or Chrome profile.

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

check verifies the selected browser instance. smoke opens and closes a temporary about:blank page to check safe connection, page targeting, and input handling.

## Browser support

| Browser | Connection | Sign-in state |
| --- | --- | --- |
| Microsoft Edge | Supported through local CDP | Separate dedicated profile |
| Google Chrome | Supported through local CDP | Separate dedicated profile |
| Chromium builds | Supported when their process is identifiable | Separate dedicated profile |
| Firefox / Safari | Not supported by this CDP bridge | Would need a separate Playwright/WebDriver connector |

## Safety

- The debug endpoint listens on 127.0.0.1 only.
- The bridge refuses an unexpected browser, port, profile, or proxy.
- Never use the normal daily browser profile, copy cookies, or commit profile data.
- Complete sign-in and verification in the browser window or through a local credential procedure explicitly authorized by the calling project. Never print or save credentials.
- A CDP debug port grants control of that dedicated browser to local software. Close the dedicated window when finished.
- This project does not bypass site controls, authentication, or approval rules.
