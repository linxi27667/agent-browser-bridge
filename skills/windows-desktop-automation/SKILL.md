---
name: windows-desktop-automation
description: Control Windows native UIA applications and custom-drawn desktop apps (WeCom/企业微信, WeChat/微信, QQ, Feishu/飞书, DingTalk/钉钉, Notepad, Explorer, etc.) through node cli/agent.cjs desktop and lib/automation. Supports app wake/launch, background WinRT OCR, OCR text clicking, foreground unlock, and verified batch delivery of text, inline images, animated GIF stickers, and files.
---

# Windows Desktop Automation

## 1. Canonical Entry & Safety Invariants

Always drive Windows desktop tasks through `node cli/agent.cjs` (or `require('./lib/automation')` in Node.js):

- **NEVER** call legacy PowerShell desktop functions (`invokeNamedButton`, `focusNamedWindow`, `sendKeysToNamedWindow`, `captureNamedWindow` — disabled at runtime with `LEGACY_INTERFACE_DISABLED`).
- **NEVER** spawn 10+ separate `agent-desktop` CLI processes per message or keystroke — combine multi-step operations into `desktop chat-send --stdin`, `desktop deliver --stdin`, or `desktop batch --stdin`.
- **NEVER** retry blindly when an action returns `disposition: 'delivered_unverified'` or `retry: 'unsafe'`. Inspect the window (`desktop ocr` or `desktop shot`) before taking further action.
- **Check Desktop Session First (`doctor`)**:
  ```powershell
  node cli/agent.cjs doctor
  ```
  Verify `desktop.isInteractiveDefaultDesktop === true` (`threadDesktop === "Default"`). If the agent tool runs inside an isolated non-input Win32 desktop (`exebox-*`), foreground focus and `SendInput` cannot reach `WinSta0\Default` (`DESKTOP_SANDBOX_ISOLATED`) — run headed desktop commands on an interactive `WinSta0\Default` terminal instead of attempting to bypass the sandbox.

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
     - Switch immediately to `--write --mode exclusive` + background WinRT OCR (`desktop ocr`, `desktop click-text`) + `desktop chat-send --stdin` (`win-helper-v4`: Explorer shell detached launch, strict `wecom`/`wechat` isolation + WeChat 4.x `"进入微信"` auto-enter, CJK radical-folded OCR, adaptive split-pane/right-drawer `chat-layout`, click-through ripple + `18ms` cursor save/restore or `navigationMode: 'keyboard_first'`) or `desktop batch --stdin`.
     - **WeChat login & cursor UX options**: `desktop click-text` / `desktop_click_text` accepts `--no-restore-cursor` (`restoreCursor: false`), `--no-ripple` (`ripple: false`), and `--click-mode physical_restore|message`; `desktop chat-send` / `desktop_chat_send` accepts `navigationMode: "auto" | "keyboard_first"` (zero mouse clicks when `"keyboard_first"` opens the session via `Ctrl+F` + `Return`), `composerClick`, `restoreCursor`, `ripple`, and `clickMode`. `desktop_act` also exposes `command: "cursor-overlay"` (`action: "enable" | "disable"`).

## 3. Standard Commands (`node cli/agent.cjs desktop ...`)

```powershell
# 1. Discover installed/running apps & visible top-level windows (read-only, zero focus steal)
node cli/agent.cjs desktop apps
node cli/agent.cjs desktop windows

# 2. Wake tray-hidden window or launch app by alias (wecom/企业微信, wechat/微信, qq, feishu, dingtalk, notepad...)
node cli/agent.cjs --write --mode exclusive desktop open-app --app wecom

# 3. Restore minimized window, unlock Windows ForegroundLockTimeout, and verify non-collapsed bounds
node cli/agent.cjs --write --mode exclusive desktop ensure-ready --app WXWork.exe --launch

# 4. Read-only background WinRT OCR (PrintWindow capture; does NOT steal focus!)
#    Regions: full | header | sidebar | messages | composer | x,y,w,h
node cli/agent.cjs desktop ocr --app WXWork.exe --region header --match "文件传输助手"
node cli/agent.cjs desktop ocr --app WXWork.exe --region sidebar --match "文件传输助手"

# 5. Click visible text on a custom-drawn window via OCR coordinates
node cli/agent.cjs --write --mode exclusive desktop click-text --app WXWork.exe --text "文件传输助手" --region sidebar

# 6. Capture window screenshot for visual inspection
node cli/agent.cjs --write --mode exclusive desktop shot --app WXWork.exe --output .\wecom-check.png
```

## 4. Verified Multi-Item Chat Delivery (Text + Image + Sticker + File)

Use `desktop chat-send --stdin` (`scenes.deliverChatSessionVerified`) to open/wake a chat app, navigate to the exact session (`sidebar` OCR click -> fallback `Ctrl+F` search), enforce the **hard OCR header safety gate (`CHAT_TARGET_UNVERIFIED` aborts with 0 items sent if header does not match)**, deliver mixed items in one `adBatch` with clipboard settle delays, and verify both visual SHA-256 change and post-delivery `messages` OCR:

```powershell
@'
{
  "app": "wecom",
  "sessionName": "文件传输助手",
  "launchIfMissing": true,
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
  let delivery = null;
  await step(
    '向企业微信文件传输助手投递图文与表情包并完成核验',
    async () => {
      delivery = await scenes.deliverChatSessionVerified(desktop, {
        app: 'wecom',
        sessionName: '文件传输助手',
        launchIfMissing: true,
        items: [
          { type: 'text', text: '自动化核验消息' },
          { type: 'image', path: 'C:\\temp\\preview.png' },
        ],
      });
      return delivery;
    },
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
  - Discovery & Diagnostics: `desktop_doctor` (includes `helperVersion` + `mcpRuntime.reloadCount`), `desktop_apps`, `desktop_windows`, `desktop_capabilities` (compact by default), `desktop_open_app`, `desktop_ensure_ready`.
  - Universal Standard UIA: `desktop_snapshot` (with `maxNodes` cap), `desktop_query` (`find | get | is | displays | surfaces`), `desktop_act` (single command or 1-process `steps[]` batch; auto-runs pure UIA in `cooperative` mode and foreground/window commands in `exclusive` mode), `desktop_deliver`.
  - Custom-Drawn & IM Apps: `desktop_ocr` (compact token-saving output by default, ~90% smaller), `desktop_shot`, `desktop_click_text` (with `scrollRetries`, `restoreCursor`, `ripple`, `clickMode`), `desktop_chat_send` (with `win-helper-v4` detached launch, WeChat 4.x login auto-enter, CJK radical-folded OCR, adaptive split-pane/drawer layout, `navigationMode: 'keyboard_first'`, `restoreCursor`, `ripple`, `sidebarScrollPages`, and `submitKey` diagnostics).
- **Auto Hot-Reload**: Modifying `lib/desktop/*.js` or `lib/automation/*.js` automatically reloads cached modules on the next idle MCP tool call without restarting the IDE.
- **MCP Tool Rule**: If `desktop_*` MCP tools are available in the agent toolset, call `desktop_doctor` first and prefer the MCP tools over isolated shell commands.
