---
name: windows-desktop-automation
description: Control Windows native UIA applications and custom-drawn desktop apps (WeCom/企业微信, WeChat/微信, QQ, Feishu/飞书, DingTalk/钉钉, Notepad, Explorer, etc.) through node cli/agent.cjs desktop and lib/automation. Supports system tray wake (Windows 11/10 hidden icons overflow), running-process discovery, app wake/launch, background WinRT OCR, 14ms cursor-restored clicking, foreground unlock, and verified batch delivery of text, inline images, animated GIF stickers, and files.
---

# Windows Desktop Automation

## 0. Foolproof Quick-Copy Recipes (Zero Flag Guessing — Start Here)

Follow these rules strictly before running any command:
1. Run all CLI commands from the repository root (`node cli/agent.cjs ...`). Use `--write --mode exclusive` for foreground/write commands — **do NOT invent `--headed`, `--target`, or `--contains`**, and **do NOT** write ad-hoc `.js` / `.ps1` / `start ""` scripts unless none of the subcommands below fit.
2. When `desktop_*` MCP tools are available (`desktop_doctor`, `desktop_chat_send`, `desktop_open_app`, `desktop_query`, `desktop_act`, `desktop_shot`, `desktop_ocr`), prefer calling the MCP tools directly instead of running shell commands inside a sandbox.
3. For screenshots, **ALWAYS** pass `--app <name>` (or `--window-id w-<hwnd>`, `--title-includes <text>`, or `--screen 0`). Omitting a target fails immediately with `INVALID_ARGS`.

### Recipe 0 (Primary Default for Vision-Capable Models): Vision-First 2-Step Send (Bypass Brittle WinRT OCR)
> **Rule when uncertain:** Windows' offline `Windows.Media.Ocr` (`desktop ocr`) is brittle on remarks, small fonts, and overlays (proven live to misread `"张佳乐"` as `"弓至乐"` and return `0` lines under lightbox veils). **Whenever you are uncertain about current UI state, modal overlays, or recipient names/remarks, ALWAYS take a screenshot (`desktop_shot` / `desktop shot`) and inspect the PNG directly with `read_file` instead of blindly relying on offline OCR!** Demote `desktop ocr` to headless/plain-script workflows with fixed names like `"文件传输助手"`.

1. **Step 1 — Switch chat via `navigateOnly: true` & inspect `afterShotPath` with `read_file`:**
```powershell
@'
{
  "app": "wechat",
  "sessionName": "张佳乐",
  "navigateOnly": true,
  "saveAfterShot": "C:\\Temp\\wechat-nav-verify.png"
}
'@ | node cli/agent.cjs --write --mode exclusive desktop chat-send --stdin
```
*(Or via MCP: `desktop_chat_send(app: "wechat", sessionName: "张佳乐", navigateOnly: true, saveAfterShot: "C:\\Temp\\wechat-nav-verify.png")`. Look at the PNG with `read_file` to verify the active right-pane chat header truly matches your intended recipient!)*

2. **Step 2 — Once visually verified, send directly with `allowCurrentSession: true`:**
```powershell
@'
{
  "app": "wechat",
  "allowCurrentSession": true,
  "saveAfterShot": "C:\\Temp\\wechat-sent-proof.png",
  "items": [
    { "type": "text", "text": "你好，这是视觉核验后直发的消息" }
  ]
}
'@ | node cli/agent.cjs --write --mode exclusive desktop chat-send --stdin
```

### Recipe A: Send Text / Image / GIF Sticker / File to WeChat or WeCom (Auto-Wakes System Tray)
`desktop chat-send --stdin` automatically resolves the live running process (`C:\Weixin\Weixin.exe` etc.) or registry `InstallPath` (with strict `WeChatAppEx.exe` / `WXWorkWeb.exe` mini-program isolation, plus optional `--window-id w-<hwnd>` pinning), wakes background tray-hidden windows from Windows 11/10 hidden icons overflow, auto-enters WeChat 4.x `"进入微信"` popups (or fast-fails in `<0.6s` with `WECHAT_LOGIN_REQUIRED` on QR screens), automatically recovers to the left-rail `"聊天"` tab if the window was parked on `发现/朋友圈/通讯录/收藏` or behind an in-window preview veil, verifies the chat header before sending, and restores the user's cursor in ~`14ms` (mouse-click runs **outside** the multi-step paste batch).

**Git Bash:**
```bash
node cli/agent.cjs --write --mode exclusive desktop chat-send --stdin <<'EOF'
{
  "app": "wechat",
  "sessionName": "文件传输助手",
  "launchIfMissing": true,
  "items": [
    { "type": "text", "text": "你好，这是自动化测试消息" },
    { "type": "image", "path": "C:/Temp/preview.png" },
    { "type": "sticker", "path": "C:/Temp/celebrate.gif" }
  ]
}
EOF
```

**PowerShell 7 (`pwsh`):**
```powershell
@'
{
  "app": "wechat",
  "sessionName": "文件传输助手",
  "launchIfMissing": true,
  "items": [
    { "type": "text", "text": "你好，这是自动化测试消息" },
    { "type": "image", "path": "C:\\Temp\\preview.png" },
    { "type": "sticker", "path": "C:\\Temp\\celebrate.gif" }
  ]
}
'@ | node cli/agent.cjs --write --mode exclusive desktop chat-send --stdin
```

### Recipe B: Send a Message AND Capture + Send Back the Chat Window Screenshot in 2 Calls
Use `"saveAfterShot"` instead of running a separate `desktop shot` call:

1. **Step 1 — Send initial message & save verified post-delivery screenshot (`afterShotPath`)**:
```powershell
@'
{
  "app": "wechat",
  "sessionName": "文件传输助手",
  "launchIfMissing": true,
  "saveAfterShot": "C:\\Temp\\chat-proof.png",
  "items": [
    { "type": "text", "text": "测试截图回传准备" }
  ]
}
'@ | node cli/agent.cjs --write --mode exclusive desktop chat-send --stdin
```
2. **Step 2 — Send the saved PNG back into the chat**:
```powershell
@'
{
  "app": "wechat",
  "sessionName": "文件传输助手",
  "launchIfMissing": false,
  "items": [
    { "type": "image", "path": "C:\\Temp\\chat-proof.png" }
  ]
}
'@ | node cli/agent.cjs --write --mode exclusive desktop chat-send --stdin
```

### Recipe C: Wake an App Hidden in Windows 11/10 System Tray (`隐藏的图标 / 后台任务`)
`open-app` already checks running processes, ignores auxiliary windows (e.g. `智能助理`, `预览`), and clicks the Windows 11 (`TopLevelWindowForOverflowXamlIsland`) / Windows 10 (`NotifyIconOverflowWindow`) system tray icon before falling back to Explorer launch:

```powershell
# Preferred: full window-ready wake (tray -> Explorer ShellExecute -> foreground unlock -> main window)
node cli/agent.cjs --write --mode exclusive desktop open-app --app wechat

# Direct tray inspection or overflow wake when debugging hidden icons:
node cli/agent.cjs desktop tray --find 微信
node cli/agent.cjs --write --mode exclusive desktop tray --open-overflow --find 微信
node cli/agent.cjs --write --mode exclusive desktop tray --app wechat
```
*(MCP equivalents: `desktop_open_app` / `desktop_query(action: "tray", find: "微信", openOverflow: true)` / `desktop_act(command: "wake-tray", app: "wechat")`.)*

### Recipe D: Screenshot & Background WinRT OCR (No Focus Steal)
```powershell
# Screenshot a specific app window (ALWAYS pass --app or --window-id w-...)
node cli/agent.cjs --write desktop shot --app wechat --out C:\Temp\wechat.png

# Background WinRT OCR without moving the mouse or stealing focus
node cli/agent.cjs desktop ocr --app wechat --region full
node cli/agent.cjs desktop ocr --app wechat --region header --find "文件传输助手"

# Read help for any subcommand instead of guessing flags
node cli/agent.cjs desktop --help
node cli/agent.cjs desktop chat-send --help
node cli/agent.cjs desktop tray --help
node cli/agent.cjs desktop shot --help
```

### Error Code Decision Table (Never Write Workaround Scripts)

| `error.code` / `disposition` | Meaning | Exact Next Action |
| --- | --- | --- |
| `WECHAT_LOGIN_REQUIRED` / `WECHAT_LOGIN_TIMEOUT` | WeChat requires QR scan or phone confirmation, or stayed on the login prompt after pressing `"进入微信"`. | **STOP immediately.** Report to the user to scan QR / confirm on their phone. Do **NOT** loop `open-app` or launch extra `.exe` copies. |
| `DESKTOP_SANDBOX_ISOLATED` | Current shell runs inside an isolated Win32 desktop (`exebox-*`) that cannot send foreground input to `WinSta0\Default`. | Switch to the `windows-desktop` MCP tools (`desktop_chat_send`, etc.) or an interactive `WinSta0\Default` terminal. Do **NOT** attempt sandbox bypasses. |
| `CHAT_TARGET_UNVERIFIED` | Header OCR after tab-recovery/search/click did not match `sessionName`; **0 items were sent**. | **STOP.** Run read-only `desktop windows --app <app>`, `desktop ocr --app <app> --region full`, and `desktop shot --app <app>` (or pin `--window-id w-<hwnd>`), and verify exact `sessionName`. |
| `DELIVERY_UNVERIFIED` or `disposition: "delivered_unverified"` / `retry: "unsafe"` | Input/paste steps were dispatched, so the message may already have been sent. | **NEVER auto-retry.** Inspect `desktop ocr --app <app> --region messages` or `desktop shot --app <app>` first. |
| `WINDOW_NOT_FOUND` | App process may only exist in background system tray, or no window matches filters. | Run `node cli/agent.cjs --write --mode exclusive desktop open-app --app <app>` (or `desktop windows`). |
| `INVALID_ARGS` | Missing `--app`/`--window-id` (e.g. on `desktop shot`), missing `--stdin`, or unsupported flag like `--headed`. | Run `node cli/agent.cjs desktop <sub> --help` and copy the exact template above. |

---

## 1. Canonical Entry & Safety Invariants

Always drive Windows desktop tasks through `node cli/agent.cjs` (or `require('./lib/automation')` in Node.js):

- **NEVER** call legacy PowerShell desktop functions (`invokeNamedButton`, `focusNamedWindow`, `sendKeysToNamedWindow`, `captureNamedWindow` — disabled at runtime with `LEGACY_INTERFACE_DISABLED`).
- **NEVER** spawn 10+ separate `agent-desktop` CLI processes per message or keystroke — combine multi-step operations into `desktop chat-send --stdin`, `desktop deliver --stdin`, or `desktop batch --stdin`.
- **NEVER** retry blindly when an action returns `disposition: 'delivered_unverified'` or `retry: 'unsafe'`. Inspect the window (`desktop ocr` or `desktop shot`) before taking further action.
- **Check Desktop Session First (`doctor`)**:
  ```powershell
  node cli/agent.cjs doctor
  ```
  Verify `desktop.isInteractiveDefaultDesktop === true` (`threadDesktop === "Default"`). If the agent tool runs inside an isolated non-input Win32 desktop (`exebox-*`), foreground focus and `SendInput` cannot reach `WinSta0\Default` (`DESKTOP_SANDBOX_ISOLATED`) — use `windows-desktop` MCP tools or an interactive `WinSta0\Default` terminal instead of attempting to bypass the sandbox.

## 2. Routing: Native UIA vs Custom-Drawn Visual Apps

1. Inspect target capabilities once (compact ~450B summary without raw UIA tree bloat):
   ```powershell
   node cli/agent.cjs desktop capabilities --app notepad.exe --no-snapshot
   node cli/agent.cjs desktop capabilities --app WXWork.exe --no-snapshot
   ```
2. Follow the observed capability mode immediately:
   - **`uia_semantic`** (Win32 / WPF / WinForms / standard Electron with UIA):
     - Stay in cooperative mode (`--write` without `--mode exclusive`) whenever possible — zero focus steal!
     - Use snapshot-qualified refs (`'@s8f3k2p9:e1'`, always single-quoted in PowerShell) with `click`, `set-value`, `clear`, `select`, `toggle`, `check`, `uncheck`, `expand`, `collapse`, `scroll`, `scroll-to`, `get`, `is`, `desktop deliver --stdin`, or `desktop batch --stdin` (or MCP `desktop_snapshot` + `desktop_query` + `desktop_act`). Note: Windows UIA `focus` (`SetFocus`) moves foreground focus and requires `exclusive` mode; classic Win32/WinForms `DropDownList` `combobox` controls expose `SetValue` rather than `SelectionItem` (`adSelect` and single-step `desktop_act` `select` auto-fallback to `set-value`, while multi-step `steps[]` batches should pass `{ "command": "set-value", "ref": "@...", "value": "..." }` when `availableActions` lists `SetValue` without `Select`; budget `timeoutMs >= writeSteps * 2500 + 5000` for large batches).
   - **`custom_ui_visual`** (WeCom `WXWork.exe`, WeChat `Weixin.exe`/`WeChat.exe`, QQ, DirectUI/Qt/CEF canvases with zero client UIA controls):
     - Do **NOT** poll `find` or `snapshot` repeatedly looking for nonexistent controls.
     - Switch immediately to `--write --mode exclusive` + **Vision-First inspection (`desktop shot` + `read_file` + `navigateOnly`/`allowCurrentSession`) whenever UI state or recipient names are uncertain**, plus optional offline WinRT OCR (`desktop ocr` / `desktop click-text`, useful for headless fixed-title runs like `"文件传输助手"`) and `desktop chat-send --stdin` (`win-helper-v5`: running-process & registry-first `exePath` discovery, Win11/10 `desktop tray` hidden-icon wake + auxiliary popup filtering, Explorer shell detached launch, strict `wecom`/`wechat` isolation, WeChat 4.x `"进入微信"` auto-enter + `<0.6s` QR fast-fail `WECHAT_LOGIN_REQUIRED`, CJK radical-folded OCR, adaptive split-pane/right-drawer `chat-layout`, single-process `14ms` cursor save/restore `click-restore` decoupled from `adBatch` + click-through ripple or `navigationMode: 'keyboard_first'`, and `saveAfterShot`).
     - **WeChat login & cursor UX options**: `desktop click-text` / `desktop_click_text` accepts `--no-restore-cursor` (`restoreCursor: false`), `--no-ripple` (`ripple: false`), and `--click-mode physical_restore|message`; `desktop chat-send` / `desktop_chat_send` accepts `navigationMode: "auto" | "keyboard_first"` (zero mouse clicks when `"keyboard_first"` opens the session via `Ctrl+F` + `Return`), `composerClick`, `restoreCursor`, `ripple`, `clickMode`, and `saveAfterShot`. `desktop_act` also exposes `command: "cursor-overlay"` (`action: "enable" | "disable"`) and `command: "wake-tray"`.

## 3. Standard Commands (`node cli/agent.cjs desktop ...`)

```powershell
# 1. Discover installed/running apps, tray icons, & visible top-level windows (read-only, zero focus steal)
node cli/agent.cjs desktop apps
node cli/agent.cjs desktop windows
node cli/agent.cjs desktop tray

# 2. Wake tray-hidden window or launch app by alias (wecom/企业微信, wechat/微信, qq, feishu, dingtalk, notepad...)
node cli/agent.cjs --write --mode exclusive desktop open-app --app wecom
node cli/agent.cjs --write --mode exclusive desktop tray --app wechat

# 3. Restore minimized window, unlock Windows ForegroundLockTimeout, and verify non-collapsed bounds
node cli/agent.cjs --write --mode exclusive desktop ensure-ready --app WXWork.exe --launch

# 4. Read-only background WinRT OCR (PrintWindow capture; does NOT steal focus!)
#    Regions: full | header | sidebar | messages | composer | x,y,w,h
node cli/agent.cjs desktop ocr --app WXWork.exe --region header --find "文件传输助手"
node cli/agent.cjs desktop ocr --app WXWork.exe --region sidebar --find "文件传输助手"

# 5. Click visible text on a custom-drawn window via OCR coordinates (~14ms cursor restore)
node cli/agent.cjs --write --mode exclusive desktop click-text --app WXWork.exe --text "文件传输助手" --region sidebar

# 6. Capture window screenshot for visual inspection (always specify --app, --window-id, --title-includes, or --screen)
node cli/agent.cjs --write desktop shot --app WXWork.exe --out C:\Temp\wecom-check.png
```

## 4. Verified Multi-Item Chat Delivery (Text + Image + Sticker + File)

Use `desktop chat-send --stdin` (`scenes.deliverChatSessionVerified`) to open/wake a chat app (including system tray overflow), navigate to the exact session (`sidebar` OCR click -> fallback `Ctrl+F` search), enforce the **hard OCR header safety gate (`CHAT_TARGET_UNVERIFIED` aborts with 0 items sent if header does not match)**, deliver mixed items in one `adBatch` (with `adMouseClick` running cleanly outside `adBatch` so cursor restores in ~`14ms`), verify both visual SHA-256 change and post-delivery `messages` OCR, and optionally export `"saveAfterShot"`:

```powershell
@'
{
  "app": "wecom",
  "sessionName": "文件传输助手",
  "launchIfMissing": true,
  "saveAfterShot": "C:\\Temp\\wecom-proof.png",
  "items": [
    { "type": "text", "text": "第一条：桌面自动化联通测试" },
    { "type": "image", "path": "C:\\temp\\chart.png" },
    { "type": "sticker", "path": "C:\\temp\\celebrate.gif" },
    { "type": "text", "text": "第二条：图文与表情包核验完成" }
  ]
}
'@ | node cli/agent.cjs --write --mode exclusive desktop chat-send --stdin
```

### Supported Item Types in `chat-send --stdin`
- `{"type": "text", "text": "..."}` (or plain string `"..."`): UTF-8 clipboard paste (`clipboard-set --stdin` + `Ctrl+V` + settle wait + `Return`).
- `{"type": "image", "path": "C:\\...\\img.png|.jpg|.bmp"}`: Auto-converts `.jpg`/`.bmp` to temporary PNG if needed, writes `CF_DIB` + `"PNG"` to clipboard (`clipboard-set --image`), pastes inline image, and sends.
- `{"type": "sticker", "path": "C:\\...\\anim.gif|.png|.jpg"}`: Uses `CF_HDROP` (`clipboard-set --file-url`) for `.gif` so animated stickers keep full animation in WeCom/WeChat/QQ, and inline bitmap paste for static `.png`/`.jpg`.
- `{"type": "file", "path": "C:\\...\\doc.pdf"}`: Writes `CF_HDROP` file drop list (`clipboard-set --file-url`), pastes, and sends.

## 5. Programmatic Workflow Example (`run --file`)

```js
// send-wecom-filehelper.cjs
module.exports = async function ({ desktop, scenes, step }) {
  await step(
    '向企业微信文件传输助手投递图文与表情包并完成核验',
    async () => scenes.deliverChatSessionVerified(desktop, {
      app: 'wecom',
      sessionName: '文件传输助手',
      launchIfMissing: true,
      saveAfterShot: 'C:\\temp\\wecom-proof.png',
      items: [
        { type: 'text', text: '自动化核验消息' },
        { type: 'image', path: 'C:\\temp\\preview.png' },
      ],
    }),
    result => result.verified === true && result.deliveredCount === 2,
  );
};
```

## 6. Native MCP Server Mode (`cli/mcp.cjs` — 14 Token-Efficient Tools + Hot-Reload)

When running inside an IDE or desktop host whose shell runner isolates child processes from `WinSta0\Default`, expose desktop automation through Antigravity's official MCP server (`node cli/mcp.cjs`):

- **Stdio MCP** (`~/.gemini/config/mcp_config.json`): `node cli/mcp.cjs --print-config --write`
- **Local Streamable HTTP MCP** (when the host also isolates stdio MCP processes, run once in the user's `WinSta0\Default` session):
  - Start server: `node cli/mcp.cjs --http --port 19235 --write` (loopback `127.0.0.1` only, rejects browser `Origin` headers, requires `Authorization: Bearer <token>`)
  - Generate config snippet: `node cli/mcp.cjs --print-config --http --port 19235 --write`
- **14 Exposed MCP Tools**:
  - Discovery & Diagnostics: `desktop_doctor` (includes `helperVersion: "win-helper-v5"` + `mcpRuntime.reloadCount`), `desktop_apps`, `desktop_windows`, `desktop_capabilities` (compact by default), `desktop_open_app` (auto-wakes tray overflow), `desktop_ensure_ready`.
  - Universal Standard UIA & Tray: `desktop_snapshot` (with `maxNodes` cap), `desktop_query` (`find | get | is | displays | surfaces | tray`), `desktop_act` (single command or 1-process `steps[]` batch; supports `wake-tray` & `cursor-overlay`, auto-runs pure UIA in `cooperative` mode and foreground/window commands in `exclusive` mode), `desktop_deliver`.
  - Custom-Drawn & IM Apps: `desktop_ocr` (compact token-saving output by default, ~90% smaller), `desktop_shot` (requires explicit `app`, `windowId`, `titleIncludes`, or `screen`), `desktop_click_text` (with `scrollRetries`, `restoreCursor`, `ripple`, `clickMode`), `desktop_chat_send` (`win-helper-v5` running-process/tray wake, WeChat 4.x auto-enter + `<0.6s` QR fast-fail, CJK radical-folded OCR, adaptive split-pane/drawer layout, `14ms` cursor restore outside `adBatch`, `navigationMode: 'keyboard_first'`, `saveAfterShot`, `sidebarScrollPages`, and `submitKey` diagnostics).
- **Auto Hot-Reload**: Modifying `lib/desktop/*.js` or `lib/automation/*.js` automatically reloads cached modules on the next idle MCP tool call without restarting the IDE.
- **MCP Tool Rule**: If `desktop_*` MCP tools are available in the agent toolset, call `desktop_doctor` first and prefer the MCP tools over isolated shell commands.
