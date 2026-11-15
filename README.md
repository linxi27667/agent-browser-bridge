# Agent Browser Bridge

A small local bridge that lets Codex / Cursor / Antigravity agents connect to a dedicated Microsoft Edge or Google Chrome debug window.

It supports Edge and Chrome on Windows through the same Chromium DevTools Protocol. Default to a dedicated profile with `--remote-debugging-port`; that path does not show the Edge Allow prompt. Each connection is checked against its local debug port, browser type, profile folder, and proxy setting before page access.

## Unified browser and desktop workflows

The browser engine remains JavaScript/Node.js; the optional native desktop engine is the Rust `agent-desktop` CLI. They cooperate through an asynchronous adapter, without rewriting either engine or mixing their element refs.

```powershell
node cli/agent.cjs --help
node cli/agent.cjs doctor
node cli/agent.cjs route --url https://example.com
node cli/agent.cjs browser scenes
node cli/agent.cjs --scene smoke browser snap --open-url https://example.com
node cli/agent.cjs --write --scene smoke browser hover-click ".todo-list li" "button.destroy"
node cli/agent.cjs desktop apps
node cli/agent.cjs desktop windows
node cli/agent.cjs desktop capabilities --app notepad.exe
node cli/agent.cjs --write --mode exclusive desktop open-app --app wecom
node cli/agent.cjs --write --mode exclusive desktop ensure-ready --app notepad.exe
node cli/agent.cjs desktop ocr --app WXWork.exe --region header --match "文件传输助手"
node cli/agent.cjs --write --mode exclusive desktop click-text --app WXWork.exe --text "文件传输助手" --region sidebar
node cli/agent.cjs --write --mode exclusive desktop chat-send --stdin
node cli/agent.cjs --write desktop deliver --stdin
node cli/agent.cjs --write --mode exclusive desktop batch --stdin
node cli/agent.cjs run --file .\my-reviewed-workflow.cjs
```

`node cli/agent.cjs` (`npm run agent -- <command>`) is the **single canonical CLI** for both browser and desktop tasks. Legacy `cli/abb.cjs` and `cli/run.cjs` remain only for `GcWebAuto` shared-file compatibility and print a redirect notice when `cli/agent.cjs` is present; legacy PowerShell desktop helpers (`invokeNamedButton`, `focusNamedWindow`, `sendKeysToNamedWindow`, `captureNamedWindow`) throw `LEGACY_INTERFACE_DISABLED` by default outside isolated GUI tests. `npm test` runs without visible desktop fixtures; `npm run test:desktop` explicitly enables the isolated GUI checks and can take focus. `npm run smoke:workflow` checks the combined workflow against isolated fixtures without physical input. Report each result separately; fixture success does not establish correctness in an untested business application. For hosts that isolate shell commands on a hidden desktop, `node cli/mcp.cjs` (`npm run mcp`) also exposes an official MCP server (`--stdio` or loopback-only Bearer-authenticated Streamable `--http`).

The new entry defaults to read-only cooperative operation. `--write` allows supported changes; known foreground operations additionally require `--mode exclusive`. These switches express the workflow's execution policy, not new business authorization. Text goes through stdin, and every `desktop.ad*` JavaScript call must be awaited. The four original PowerShell helpers remain legacy APIs and do not inherit this policy.

Use APIs, CLIs, or direct file processing before automating a UI. Use CDP for web content, UI Automation for native controls, and physical input only when necessary. A workflow step counts as verified only when its explicit postcondition returns `true`; a successful dispatch alone is insufficient. No uncertain action is automatically retried.

Read the [complete Chinese usage and recovery guide](docs/automation.md) before running a workflow. Trusted workflow JavaScript is executable code, not a security sandbox. Cooperative mode rejects known foreground commands; it cannot prevent an application from opening its own UI or stop a human from using the shared desktop.

## Hybrid AX/DOM Snapshot, Semantic Locators & Code-First Runner (0.7.0)

v0.7.0 integrates the open-source capabilities of `vercel-labs/agent-browser` (hybrid ARIA + cursor-interactive DOM snapshot, hidden radio/checkbox promotion, durable `@e1` refs, LCS `diffSnapshots`) and `citrolabs/ego-lite` (semantic locators, actionability hit-test, code-first runner with `page-context-guard`, and structured site `learnings/`), while keeping 100% of AgentBrowserBridge's security invariants (`guardExpression` + dedicated profile verification):

| Capability | API / Syntax | Description |
| --- | --- | --- |
| Hybrid Snapshot | `snapshot(page, guard, opts)` / `snapshotText(page, guard, opts)` | Extracts ARIA roles + custom `cursor:pointer` / `onclick` / `tabindex` elements + promotes hidden radio/checkboxes into `@e1`, `@e2` refs |
| Snapshot Diff | `diffSnapshots(before, after)` | Line-level LCS diff returning only `{ changed, additions, removals, diff }` after an action |
| Ref & Semantic Locators | `@e1`, `role:button[name="查询"]`, `text="数电票"`, `.t-select-option:text-is("取得发票")`, `button:has-text("导出") >> nth=0` | Supported across `waitForSelector`, `fillNative`, `clickNative`, `clickByBox`, `dragByBox`, `selectOption`, `readUnique`, `captureUniquePng` |
| Code-First Runner | `npm run exec -- --code "..."` / `cdp.runScript(code)` | Executes multi-step automation in one turn and intercepts accidental `document`/`window`/`location` calls in Node |
| Site Learnings | `loadSiteLearning(url)` / `runSiteTool(site, tool, args, ctx)` | Reusable domain knowledge and read-only tools under `learnings/` (`k3cloud`, `etax-gd`) |

Example (Observe -> Act by `@ref` or semantic locator -> Diff):

```js
const cdp = require('./lib/cdp');
await cdp.withDedicatedTab({ url: 'https://example.com', ownerTag: 'agent-A' }, async (page) => {
  const guard = 'location.hostname === "example.com"';
  const before = await cdp.snapshot(page, guard, { interactiveOnly: true });
  await cdp.fillNative(page, '@e1', '26442000', guard);
  await cdp.clickByBox(page, 'role:button[name="查询"]', guard, { checkIntercept: true });
  const after = await cdp.snapshot(page, guard, { interactiveOnly: true });
  console.log(cdp.diffSnapshots(before, after).diff);
});
```

## Multi-agent concurrency (0.6.0+)

When several agents share one debug browser, they used to fight over the same tab and foreground focus. This release merges GcWebAuto’s serverless lock model:

| Mechanism | API | Role |
| --- | --- | --- |
| Target lease | `acquireTargetLease` / `withDedicatedTab` | One task per `targetId`; conflict throws `CDP_TARGET_LEASED` |
| UI short lock | `withUiLock` (auto via `page.autoUiLock`) | Serialize click / fill / drag / key / screenshot on one port |
| Activate tab | `activateTarget` | Bring the leased tab to the front inside the UI lock |

Recommended pattern:

```js
const cdp = require('./lib/cdp');
await cdp.withDedicatedTab({ url: 'about:blank', ownerTag: 'agent-A' }, async (page, { targetId }) => {
  // page.autoUiLock === true；fillNative / clickByBox 等会自动排队
  await cdp.fillNative(page, '#q', 'text', 'location.href === "about:blank"');
});
```

Same site + same account writes must still be serial at the business layer. Heavy or multi-account work should use another `-Scene` / port. Lock files: `%LOCALAPPDATA%\AgentBrowserBridge\locks` (`BROWSER_BRIDGE_LOCK_DIR` for tests).

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

check verifies the selected browser instance. smoke opens and closes a temporary about:blank page to check connection, unique selector wait, native click, Chinese input, DOM drag, Enter/Tab/Escape, select option, readback, captcha-image capture, user-auth wait, dedicated-tab lease, concurrent dual-task isolation, hybrid `@ref` snapshot, semantic locators (`role:`, `:text-is()`), and `diffSnapshots`. `npm test` covers concurrency, locator/snapshot/runner/learnings and automation contracts without opening the desktop GUI fixtures. Use `npm run test:desktop` only for the explicit isolated desktop check; it can take foreground focus.

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
- New desktop integrations use `createDesktopClient` with explicit execution policy. The legacy PowerShell helpers need an explicit button name or exact window title, but do not inherit the new client's read-only or foreground checks. Never use them to bypass a policy refusal.
- A CDP debug port grants control of that dedicated browser to local software. Leave a user's existing window open; close it only when the user explicitly asks.
- This project does not bypass site controls, authentication, or approval rules.
