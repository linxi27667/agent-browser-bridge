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

1. Inspect target capabilities once:
   ```powershell
   node cli/agent.cjs desktop capabilities --app notepad.exe
   node cli/agent.cjs desktop capabilities --app WXWork.exe
   ```
2. Follow the observed capability mode immediately:
   - **`uia_semantic`** (Win32 / WPF / WinForms / standard Electron with UIA):
     - Stay in cooperative mode (`--write` without `--mode exclusive`) whenever possible.
     - Use snapshot-qualified refs (`'@s8f3k2p9:e1'`, always single-quoted in PowerShell) with `adSetValue`, `adClick`, `adGet`, or `desktop deliver --stdin`.
   - **`custom_ui_visual`** (WeCom `WXWork.exe`, WeChat `Weixin.exe`/`WeChat.exe`, QQ, DirectUI/Qt/CEF canvases with zero client UIA controls):
     - Do **NOT** poll `find` or `snapshot` repeatedly looking for nonexistent controls.
     - Switch immediately to `--write --mode exclusive` + background WinRT OCR (`desktop ocr`, `desktop click-text`) + `desktop chat-send --stdin` or `desktop batch --stdin`.

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
