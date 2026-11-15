const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const { validateCommand, normalizeBatchSteps } = require('../lib/desktop/agentDesktopPolicy');
const appRegistry = require('../lib/desktop/appRegistry');
const winHelper = require('../lib/desktop/winHelper');
const {
  createAutomation,
  loadLocalConfig,
  ensureWindowReady,
  deliverChatSessionVerified,
  clickTextVerified,
} = require('../lib/automation');
const { isStrictHeaderLineMatch } = require('../lib/automation/scenes/desktopChat');

test('winHelper normalizes CJK OCR spacing and performs bounded fuzzy sub-span matching', () => {
  assert.equal(winHelper.normalizeOcrText('文 件 传 输 助 手'), '文件传输助手');
  assert.equal(winHelper.normalizeOcrText('搜索 (Ctrl+F)  刚刚'), '搜索 (Ctrl+F) 刚刚');

  const fakeOcr = {
    imageWidth: 960,
    imageHeight: 680,
    lines: [
      {
        text: '置顶文件传蝓助手 21:45',
        rawText: '置 顶 文 件 传 蝓 助 手 21:45',
        x: 70,
        y: 94,
        width: 150,
        height: 14,
        words: [
          { text: '置', x: 70, y: 94, width: 13, height: 14 },
          { text: '顶', x: 83, y: 94, width: 13, height: 14 },
          { text: '文', x: 100, y: 94, width: 13, height: 14 },
          { text: '件', x: 113, y: 94, width: 13, height: 14 },
          { text: '传', x: 126, y: 94, width: 13, height: 14 },
          { text: '蝓', x: 139, y: 94, width: 13, height: 14 },
          { text: '助', x: 152, y: 94, width: 13, height: 14 },
          { text: '手', x: 165, y: 94, width: 13, height: 14 },
          { text: '21:45', x: 185, y: 95, width: 35, height: 12 },
        ],
      },
      {
        text: '研发群刚刚',
        rawText: '研 发 群 刚 刚',
        x: 70,
        y: 150,
        width: 72,
        height: 14,
        words: [
          { text: '研', x: 70, y: 150, width: 14, height: 14 },
          { text: '发', x: 84, y: 150, width: 14, height: 14 },
          { text: '群', x: 98, y: 150, width: 14, height: 14 },
          { text: '刚', x: 118, y: 150, width: 12, height: 14 },
          { text: '刚', x: 130, y: 150, width: 12, height: 14 },
        ],
      },
    ],
  };
  const bounds = { x: 100, y: 50, width: 960, height: 680 };
  const fileHelperHits = winHelper.findOcrMatches(fakeOcr, '文件传输助手', bounds);
  assert.equal(fileHelperHits.length, 1);
  assert.equal(fileHelperHits[0].distance, 1);
  assert.equal(fileHelperHits[0].confidence, 'ocr_fuzzy_1');
  assert.equal(fileHelperHits[0].imageRect.x, 100);
  assert.equal(fileHelperHits[0].imageRect.width, 78);
  assert.equal(fileHelperHits[0].screen.center.x, 239);

  // 2-char mismatch on 6-char query must NOT false-match
  assert.equal(winHelper.findOcrMatches(fakeOcr, '文件传输群', bounds).length, 0);
  // 1-char mismatch on 3-char query must NOT false-match
  assert.equal(winHelper.findOcrMatches(fakeOcr, '开发群', bounds).length, 0);
  // Exact 3-char query matches tightly
  const yfHits = winHelper.findOcrMatches(fakeOcr, '研发群', bounds);
  assert.equal(yfHits.length, 1);
  assert.equal(yfHits[0].distance, 0);
  assert.equal(yfHits[0].imageRect.width, 42);

  // Header prefix-contamination guard: "研发群" must NOT match "外部研发群"
  assert.equal(isStrictHeaderLineMatch('文件传输助手', '文件传输助手'), true);
  assert.equal(isStrictHeaderLineMatch('文 件 传 蝓 助 手', '文件传输助手'), true);
  assert.equal(isStrictHeaderLineMatch('研发技术讨论群 (28)', '研发技术讨论群'), true);
  assert.equal(isStrictHeaderLineMatch('外部研发群', '研发群'), false);
  assert.equal(isStrictHeaderLineMatch('文件传输群', '文件传输助手'), false);
});

test('ensureWindowReady enforces readOnly and exclusive policy before launching or focusing', async () => {
  const readOnlyClient = {
    adPolicy: () => ({ readOnly: true, mode: 'exclusive' }),
    adInspectCapabilities: async () => {
      const err = new Error('missing');
      err.code = 'WINDOW_NOT_FOUND';
      throw err;
    },
    adListWindows: async () => [],
  };
  await assert.rejects(
    ensureWindowReady(readOnlyClient, { app: 'notepad' }, { launchIfMissing: true }),
    { code: 'READ_ONLY_BLOCKED' },
  );

  const coopClient = {
    adPolicy: () => ({ readOnly: false, mode: 'cooperative' }),
    adInspectCapabilities: async () => ({
      windowId: 'w-999',
      window: { id: 'w-999', pid: 1234 },
      mode: 'custom_ui_visual',
      minimized: false,
      isFocused: false,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    }),
  };
  await assert.rejects(
    ensureWindowReady(coopClient, { windowId: 'w-999' }, { focus: 'auto' }),
    { code: 'DESKTOP_FOREGROUND_REQUIRED' },
  );
});

test('agentDesktopPolicy allows clipboard-set --image and --file-url while enforcing exclusive writable policy', () => {
  const absPng = path.resolve(os.tmpdir(), 'sample.png');
  const absGif = path.resolve(os.tmpdir(), 'sticker.gif');
  const writableExclusive = { readOnly: false, mode: 'exclusive' };

  assert.throws(
    () => validateCommand(['clipboard-set', `--image=${absPng}`], undefined, { readOnly: true, mode: 'exclusive' }),
    { code: 'READ_ONLY_BLOCKED' },
  );
  assert.throws(
    () => validateCommand(['clipboard-set', `--image=${absPng}`], undefined, { readOnly: false, mode: 'cooperative' }),
    { code: 'DESKTOP_FOREGROUND_REQUIRED' },
  );
  assert.throws(
    () => validateCommand(['clipboard-set', '--image=relative.png'], undefined, writableExclusive),
    { code: 'INVALID_ARGS' },
  );
  assert.throws(
    () => validateCommand(['clipboard-set', '--stdin', `--image=${absPng}`], 'conflict', writableExclusive),
    { code: 'INVALID_ARGS' },
  );

  const okImg = validateCommand(['clipboard-set', `--image=${absPng}`], undefined, writableExclusive);
  assert.equal(okImg.command, 'clipboard-set');
  assert.equal(okImg.mutating, true);

  const okFile = validateCommand(['clipboard-set', `--file-url=${absGif}`], undefined, writableExclusive);
  assert.equal(okFile.command, 'clipboard-set');

  const batchPlan = normalizeBatchSteps(
    [
      { command: 'clipboard-set', text: 'hello' },
      { command: 'clipboard-set', image: absPng },
      { command: 'clipboard-set', fileUrls: [absGif] },
      { command: 'clipboard-clear' },
    ],
    writableExclusive,
    'w-100',
  );
  assert.equal(batchPlan.items.length, 4);
  assert.equal(batchPlan.hasText, true);
  assert.deepEqual(batchPlan.items[1].batchArgs, { image: absPng });
  assert.deepEqual(batchPlan.items[2].batchArgs, { file_url: [absGif] });
});

test('appRegistry resolves built-in Chinese and English aliases and prioritizes primary windows', () => {
  const wecom = appRegistry.resolveAppSpec('企业微信');
  assert.equal(wecom.key, 'wecom');
  assert.equal(wecom.layoutProfile, 'im_split_pane');

  const wechat = appRegistry.resolveAppSpec('微信');
  assert.equal(wechat.key, 'wechat');

  const notepad = appRegistry.resolveAppSpec('记事本');
  assert.equal(notepad.key, 'notepad');

  const windows = [
    { id: 'w-tiny', app: 'WXWork.exe', title: 'Shadow', is_focused: false, minimized: false, bounds: { x: 0, y: 0, width: 40, height: 20 } },
    { id: 'w-main', app: 'WXWork.exe', title: '企业微信', is_focused: false, minimized: false, bounds: { x: 80, y: 60, width: 960, height: 680 } },
  ];
  const matched = appRegistry.matchWindowsList(windows, wecom, {});
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, 'w-main');
});

const SIM_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal sealed class ChatEntry {
  public string Kind;
  public string Label;
  public Bitmap Thumb;
}

internal sealed class SimForm : Form {
  private const int WM_PASTE = 0x0302;
  private const int WM_USER_SIM_KEY = 0x0400 + 77;
  private readonly string stateFile;
  private bool inSearchPopup = false;
  private string searchQuery = "";
  private bool composerFocused = false;
  private readonly List<ChatEntry> staged = new List<ChatEntry>();
  private string activeSession = "研发技术讨论群";
  private readonly List<string> sidebarSessions = new List<string>();
  private readonly List<string> allSessions = new List<string> {
    "研发技术讨论群",
    "部门周报汇总群",
    "文件传输助手",
    "设备联调通知群"
  };
  private readonly Dictionary<string, List<ChatEntry>> history = new Dictionary<string, List<ChatEntry>>();

  public SimForm(string statePath, bool trayHidden, bool searchOnly) {
    this.stateFile = statePath;
    this.Text = "企业微信";
    this.StartPosition = FormStartPosition.Manual;
    this.Bounds = new Rectangle(80, 60, 960, 680);
    this.DoubleBuffered = true;
    this.KeyPreview = true;
    foreach (var s in allSessions) history[s] = new List<ChatEntry>();
    sidebarSessions.Add("研发技术讨论群");
    sidebarSessions.Add("部门周报汇总群");
    if (!searchOnly) sidebarSessions.Add("文件传输助手");
    sidebarSessions.Add("设备联调通知群");
    if (trayHidden) {
      this.ShowInTaskbar = false;
      this.WindowState = FormWindowState.Minimized;
      this.Visible = false;
    }
    SaveState();
  }

  public void WakeFromTray() {
    this.ShowInTaskbar = true;
    this.Visible = true;
    this.WindowState = FormWindowState.Normal;
    this.Bounds = new Rectangle(80, 60, 960, 680);
    this.Show();
    this.BringToFront();
    this.Activate();
    this.Invalidate();
    SaveState();
  }

  private static string Esc(string s) {
    return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "\\n");
  }

  private void SaveState() {
    if (string.IsNullOrEmpty(stateFile)) return;
    var sb = new StringBuilder();
    sb.Append("{\"visible\":").Append(this.Visible ? "true" : "false");
    sb.Append(",\"activeSession\":\"").Append(Esc(activeSession)).Append("\",\"sessions\":{");
    bool first = true;
    foreach (var kv in history) {
      if (!first) sb.Append(",");
      first = false;
      sb.Append("\"").Append(Esc(kv.Key)).Append("\":[");
      for (int i = 0; i < kv.Value.Count; i++) {
        if (i > 0) sb.Append(",");
        sb.Append("{\"kind\":\"").Append(Esc(kv.Value[i].Kind)).Append("\",\"label\":\"").Append(Esc(kv.Value[i].Label)).Append("\"}");
      }
      sb.Append("]");
    }
    sb.Append("}}");
    try { File.WriteAllText(stateFile, sb.ToString(), new UTF8Encoding(false)); } catch {}
  }

  private List<string> FilteredSearch() {
    var list = new List<string>();
    if (string.IsNullOrEmpty(searchQuery)) return list;
    foreach (var s in allSessions) {
      if (s.IndexOf(searchQuery.Trim(), StringComparison.OrdinalIgnoreCase) >= 0) list.Add(s);
    }
    return list;
  }

  private void HandleClickClient(int x, int y) {
    if (x >= 55 && x <= 275 && y >= 10 && y <= 54) {
      inSearchPopup = true; searchQuery = ""; composerFocused = false;
      Invalidate(); SaveState(); return;
    }
    if (x >= 55 && x <= 285 && y >= 68) {
      var rows = inSearchPopup ? FilteredSearch() : sidebarSessions;
      int idx = (y - 68) / 58;
      if (idx >= 0 && idx < rows.Count) {
        activeSession = rows[idx]; inSearchPopup = false; searchQuery = ""; staged.Clear(); composerFocused = false;
        Invalidate(); SaveState(); return;
      }
    }
    if (x >= 285 && y >= 440) {
      inSearchPopup = false; composerFocused = true;
      Invalidate(); SaveState(); return;
    }
    composerFocused = false; Invalidate(); SaveState();
  }

  private void HandleLogicalCombo(string combo) {
    if (combo == "ctrl+f") {
      inSearchPopup = true; searchQuery = ""; composerFocused = false;
      Invalidate(); SaveState();
    } else if (combo == "escape") {
      inSearchPopup = false; searchQuery = "";
      Invalidate(); SaveState();
    } else if (combo == "ctrl+v") {
      HandlePaste();
    } else if (combo == "return" || combo == "enter") {
      if (inSearchPopup) {
        var hits = FilteredSearch();
        if (hits.Count > 0) activeSession = hits[0];
        inSearchPopup = false; searchQuery = "";
        Invalidate(); SaveState(); return;
      }
      if (composerFocused && staged.Count > 0) {
        history[activeSession].AddRange(staged);
        staged.Clear();
        Invalidate(); SaveState();
      }
    }
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_PASTE) {
      HandlePaste();
      return;
    }
    if (m.Msg == WM_USER_SIM_KEY) {
      int code = m.WParam.ToInt32();
      if (code == 1) HandleLogicalCombo("ctrl+f");
      else if (code == 2) HandleLogicalCombo("escape");
      else if (code == 3) HandleLogicalCombo("ctrl+v");
      else if (code == 4) HandleLogicalCombo("return");
      return;
    }
    base.WndProc(ref m);
  }

  protected override void OnMouseDown(MouseEventArgs e) {
    base.OnMouseDown(e);
    HandleClickClient(e.X, e.Y);
  }

  protected override void OnKeyDown(KeyEventArgs e) {
    base.OnKeyDown(e);
    if (e.Control && e.KeyCode == Keys.F) { e.Handled = true; HandleLogicalCombo("ctrl+f"); }
    else if (e.KeyCode == Keys.Escape) { e.Handled = true; HandleLogicalCombo("escape"); }
    else if (e.Control && e.KeyCode == Keys.V) { e.Handled = true; HandleLogicalCombo("ctrl+v"); }
    else if (e.KeyCode == Keys.Enter || e.KeyCode == Keys.Return) { e.Handled = true; HandleLogicalCombo("return"); }
  }

  private void HandlePaste() {
    if (inSearchPopup) {
      if (Clipboard.ContainsText()) { searchQuery = Clipboard.GetText().Trim(); Invalidate(); SaveState(); }
      return;
    }
    if (!composerFocused) return;
    if (Clipboard.ContainsFileDropList()) {
      foreach (string f in Clipboard.GetFileDropList()) {
        string ext = Path.GetExtension(f ?? "").ToLowerInvariant();
        Bitmap thumb = null; string dims = "";
        try { using (var img = Image.FromFile(f)) { dims = img.Width + "x" + img.Height; thumb = new Bitmap(img, new Size(48, 48)); } } catch {}
        staged.Add(new ChatEntry {
          Kind = ext == ".gif" ? "sticker" : "file",
          Label = (ext == ".gif" ? "[表情:" : "[文件:") + Path.GetFileName(f) + " " + dims + "]",
          Thumb = thumb
        });
      }
      Invalidate(); SaveState(); return;
    }
    if (Clipboard.ContainsImage()) {
      using (var img = Clipboard.GetImage()) {
        if (img != null) {
          staged.Add(new ChatEntry {
            Kind = "image",
            Label = "[图片:" + img.Width + "x" + img.Height + "]",
            Thumb = new Bitmap(img, new Size(64, 42))
          });
          Invalidate(); SaveState(); return;
        }
      }
    }
    if (Clipboard.ContainsText()) {
      string txt = Clipboard.GetText();
      if (!string.IsNullOrEmpty(txt)) { staged.Add(new ChatEntry { Kind = "text", Label = txt }); Invalidate(); SaveState(); }
    }
  }

  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
    int w = ClientSize.Width, h = ClientSize.Height;
    using (var rail = new SolidBrush(Color.FromArgb(46, 54, 68))) g.FillRectangle(rail, 0, 0, 56, h);
    using (var side = new SolidBrush(Color.FromArgb(247, 248, 250))) g.FillRectangle(side, 56, 0, 224, h);
    using (var main = new SolidBrush(Color.FromArgb(242, 243, 245))) g.FillRectangle(main, 280, 0, w - 280, h);
    g.FillRectangle(Brushes.White, 280, 0, w - 280, 58);
    g.FillRectangle(Brushes.White, 280, 460, w - 280, h - 460);
    using (var fontH = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold))
    using (var fontR = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Regular)) {
      g.FillRectangle(Brushes.Gainsboro, 66, 14, 202, 32);
      g.DrawString(inSearchPopup ? (searchQuery == "" ? "输入搜索关键词" : searchQuery) : "搜索 (Ctrl+F)", fontR, Brushes.DimGray, 74, 20);
      var rows = inSearchPopup ? FilteredSearch() : sidebarSessions;
      for (int i = 0; i < rows.Count; i++) {
        int ry = 68 + i * 58;
        g.FillRectangle(Brushes.White, 58, ry, 220, 52);
        g.DrawString(rows[i], fontR, Brushes.Black, 72, ry + 16);
      }
      g.DrawString(activeSession, fontH, Brushes.Black, 304, 17);
      var msgs = history[activeSession];
      int my = 76;
      for (int i = Math.Max(0, msgs.Count - 6); i < msgs.Count; i++) {
        var entry = msgs[i];
        int bh = entry.Thumb != null ? 54 : 34;
        g.FillRectangle(Brushes.AliceBlue, 310, my, Math.Min(560, w - 340), bh);
        if (entry.Thumb != null) {
          g.DrawImage(entry.Thumb, 318, my + 4);
          g.DrawString(entry.Label, fontR, Brushes.Black, 392, my + 16);
        } else {
          g.DrawString(entry.Label, fontR, Brushes.Black, 320, my + 8);
        }
        my += bh + 8;
      }
      g.DrawString(composerFocused ? "输入框已就绪" : "点击此处输入消息", fontR, Brushes.Gray, 304, 480);
    }
  }
}

internal static class Program {
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr hWnd, ref Point lpPoint);
  [DllImport("user32.dll")] private static extern IntPtr SendMessageW(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

  [STAThread]
  public static int Main(string[] args) {
    try { SetProcessDPIAware(); } catch {}
    if (args.Length >= 3 && args[0] == "--dispatch-click") {
      IntPtr hwnd = new IntPtr(long.Parse(args[1]));
      string[] xy = args[2].Split(',');
      var pt = new Point(int.Parse(xy[0]), int.Parse(xy[1]));
      ScreenToClient(hwnd, ref pt);
      IntPtr lParam = new IntPtr(((pt.Y & 0xFFFF) << 16) | (pt.X & 0xFFFF));
      SendMessageW(hwnd, 0x0201, new IntPtr(1), lParam);
      SendMessageW(hwnd, 0x0202, IntPtr.Zero, lParam);
      return 0;
    }
    if (args.Length >= 3 && args[0] == "--dispatch-combo") {
      IntPtr hwnd = new IntPtr(long.Parse(args[1]));
      string combo = args[2].ToLowerInvariant();
      int code = combo == "ctrl+f" ? 1 : (combo == "escape" ? 2 : (combo == "ctrl+v" ? 3 : 4));
      SendMessageW(hwnd, 0x0400 + 77, new IntPtr(code), IntPtr.Zero);
      return 0;
    }
    string stateFile = ""; bool tray = false; bool searchOnly = false; string inst = "T1";
    for (int i = 0; i < args.Length; i++) {
      if (args[i] == "--state") stateFile = args[++i];
      else if (args[i] == "--tray-hidden") tray = true;
      else if (args[i] == "--search-only") searchOnly = true;
      else if (args[i] == "--instance") inst = args[++i];
    }
    string evtName = "Local\\AbbSimWake_" + inst;
    bool created = false;
    using (var mtx = new Mutex(true, "Local\\AbbSimMtx_" + inst, out created)) {
      if (!created) {
        try { using (var ev = EventWaitHandle.OpenExisting(evtName)) ev.Set(); } catch {}
        return 0;
      }
      var wakeEv = new EventWaitHandle(false, EventResetMode.AutoReset, evtName);
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      var form = new SimForm(stateFile, tray, searchOnly);
      var th = new Thread(() => {
        while (!form.IsDisposed) {
          if (wakeEv.WaitOne(200)) {
            try { if (!form.IsDisposed) form.BeginInvoke(new Action(() => form.WakeFromTray())); } catch {}
          }
        }
      }) { IsBackground = true };
      th.Start();
      if (tray) { var h = form.Handle; Application.Run(); }
      else Application.Run(form);
    }
    return 0;
  }
}
`;

function createTestDesktopAdapter(realDesktop, simExe, isInteractiveDesktop) {
  if (isInteractiveDesktop) return realDesktop;
  // On headless/non-input Win32 desktops (where GetForegroundWindow() == 0 and kernel SendInput is blocked),
  // keep real PrintWindow screenshot, real OCR, real list-windows, and real Win32 clipboard-set (--stdin/--image/--file-url),
  // while routing physical focus/mouse/key steps to the same-desktop simulator HWND.
  let focusedWindowId = null;
  const parseHwnd = wid => String(wid || '').replace(/^w-/, '');

  const wrapList = async (app, call) => {
    const list = await realDesktop.adListWindows(app, call);
    return (Array.isArray(list) ? list : []).map(w => ({
      ...w,
      is_focused: w.id === focusedWindowId ? true : Boolean(w.is_focused),
    }));
  };

  return {
    ...realDesktop,
    adListWindows: wrapList,
    adInspectCapabilities: async (app, call = {}) => {
      const cap = await realDesktop.adInspectCapabilities(app, call);
      return {
        ...cap,
        isFocused: cap.windowId === focusedWindowId ? true : cap.isFocused,
        window: cap.window ? { ...cap.window, is_focused: cap.windowId === focusedWindowId ? true : cap.window.is_focused } : cap.window,
      };
    },
    adFocusWindow: async (_app, call = {}) => {
      focusedWindowId = call.windowId;
      return { ok: true };
    },
    adMouseClick: async (x, y, call = {}) => {
      execFileSync(simExe, ['--dispatch-click', parseHwnd(call.windowId), `${Math.round(x)},${Math.round(y)}`], { windowsHide: true });
      return { ok: true };
    },
    adBatch: async (steps, call = {}) => {
      const t0 = Date.now();
      const results = [];
      for (let i = 0; i < steps.length; i += 1) {
        const s = steps[i];
        if (s.command === 'wait') {
          await new Promise(r => setTimeout(r, s.ms));
          results.push({ index: i, command: 'wait', execution: 'completed', ok: true, data: { waited_ms: s.ms } });
        } else if (s.command === 'screenshot') {
          const data = await realDesktop.adScreenshot(s.app, s.outputPath ?? s.path, { windowId: s.windowId ?? call.windowId });
          results.push({ index: i, command: 'screenshot', execution: 'completed', ok: true, data });
        } else if (s.command === 'clipboard-set') {
          let data;
          if (s.image) data = await realDesktop.adClipboardSetImage(s.image);
          else if (s.fileUrls || s.fileUrl || s.file_url) data = await realDesktop.adClipboardSetFiles(s.fileUrls || s.fileUrl || s.file_url);
          else data = await realDesktop.adClipboardSet(s.text ?? s.value);
          results.push({ index: i, command: 'clipboard-set', execution: 'completed', ok: true, data });
        } else if (s.command === 'clipboard-clear') {
          const data = await realDesktop.adClipboardClear();
          results.push({ index: i, command: 'clipboard-clear', execution: 'completed', ok: true, data });
        } else if (s.command === 'mouse-click') {
          const xy = s.xy || `${Math.round(s.x)},${Math.round(s.y)}`;
          execFileSync(simExe, ['--dispatch-click', parseHwnd(s.windowId ?? call.windowId), xy], { windowsHide: true });
          results.push({ index: i, command: 'mouse-click', execution: 'completed', ok: true, data: {} });
        } else if (s.command === 'press') {
          execFileSync(simExe, ['--dispatch-combo', parseHwnd(s.windowId ?? call.windowId), s.combo ?? s.key], { windowsHide: true });
          results.push({ index: i, command: 'press', execution: 'completed', ok: true, data: {} });
        } else {
          throw new Error(`Unexpected step command in test adapter: ${s.command}`);
        }
      }
      return {
        results,
        total_entries: steps.length,
        completed_entries: results.length,
        not_started_entries: 0,
        elapsed_ms: Date.now() - t0,
        transport: 'headless-sim-bridge',
      };
    },
  };
}

test('Windows live custom-drawn WeCom simulator: tray wake, OCR session switch, Ctrl+F search, PNG/JPG/GIF sticker delivery, and target safety gate', { skip: process.platform !== 'win32' }, async (t) => {
  const loaded = loadLocalConfig({});
  const realAuto = createAutomation({ ...loaded.options, readOnly: false, mode: 'exclusive' });
  const adReady = await realAuto.desktop.adAvailable();
  if (!adReady) {
    t.skip('agent-desktop binary not configured on this machine');
    return;
  }
  const envInfo = await winHelper.inspectDesktopEnvironment();
  if (!envInfo.ocrLanguages || envInfo.ocrLanguages.length === 0) {
    t.skip('No Windows OCR language pack installed');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-wecom-e2e-'));
  const simCs = path.join(tmpDir, 'AbbWeComSim.cs');
  const simExe = path.join(tmpDir, 'AbbWeComSim.exe');
  const pngFile = path.join(tmpDir, 'chart.png');
  const jpgFile = path.join(tmpDir, 'photo.jpg');
  const gifFile = path.join(tmpDir, 'sticker.gif');

  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  fs.writeFileSync(simCs, SIM_CSHARP, 'utf8');
  execFileSync(csc, ['/nologo', '/optimize+', '/target:winexe', `/out:${simExe}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', simCs], {
    windowsHide: true,
  });

  // Generate test PNG, JPG, and GIF via PowerShell System.Drawing
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.Drawing;
     $b1 = New-Object System.Drawing.Bitmap(220, 120);
     $g1 = [System.Drawing.Graphics]::FromImage($b1); $g1.Clear([System.Drawing.Color]::RoyalBlue); $g1.Dispose();
     $b1.Save('${pngFile.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);
     $b1.Save('${jpgFile.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Jpeg);
     $b1.Dispose();
     $b2 = New-Object System.Drawing.Bitmap(88, 88);
     $g2 = [System.Drawing.Graphics]::FromImage($b2); $g2.Clear([System.Drawing.Color]::Gold); $g2.Dispose();
     $b2.Save('${gifFile.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Gif);
     $b2.Dispose();`,
  ], { windowsHide: true });

  const desktop = createTestDesktopAdapter(realAuto.desktop, simExe, envInfo.isInteractiveDefaultDesktop);

  try {
    // 1. Tray-hidden start + wake + sidebar OCR switch + 5 mixed items (2 text + PNG + JPG + GIF sticker)
    const stateA = path.join(tmpDir, 'state-a.json');
    const instA = `A_${process.pid}_${Date.now()}`;
    const childA = spawn(simExe, ['--tray-hidden', '--instance', instA, '--state', stateA], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 350));

    try {
      const preWins = await appRegistry.findMatchingWindows(desktop, 'AbbWeComSim');
      assert.equal(preWins.windows.length, 0, 'Tray-hidden simulator should start with 0 visible windows');

      const shotsDirA = path.join(tmpDir, 'shots-a');
      const resA = await deliverChatSessionVerified(desktop, {
        app: 'AbbWeComSim',
        exePath: simExe,
        launchArgs: ['--instance', instA],
        sessionName: '文件传输助手',
        screenshotDir: shotsDirA,
        items: [
          '第一条自动测试消息',
          '第二条自动测试消息',
          { type: 'image', path: pngFile },
          { type: 'image', path: jpgFile },
          { type: 'sticker', path: gifFile },
        ],
      });

      assert.equal(resA.ok, true);
      assert.equal(resA.verified, true);
      assert.equal(fs.existsSync(path.join(shotsDirA, 'media')), false, 'Temporary converted PNGs must not leak into screenshotDir');
      assert.ok(resA.windowActions.includes('launch'), 'Should wake hidden tray app via single-instance launch');
      assert.equal(resA.sessionVerified, true);
      assert.equal(resA.navigationMethod, 'sidebar_click');
      assert.equal(resA.deliveredCount, 5);
      assert.deepEqual(resA.itemBreakdown, { text: 2, image: 2, sticker: 1, file: 0 });
      assert.ok(resA.ocrVerifiedTextCount >= 1, 'Post-delivery OCR should verify rendered message bubbles');

      const groundA = JSON.parse(fs.readFileSync(stateA, 'utf8'));
      assert.equal(groundA.activeSession, '文件传输助手');
      assert.equal(groundA.sessions['研发技术讨论群'].length, 0, 'Trap initial session must receive ZERO items');
      assert.equal(groundA.sessions['文件传输助手'].length, 5);
      assert.equal(groundA.sessions['文件传输助手'][0].label, '第一条自动测试消息');
      assert.equal(groundA.sessions['文件传输助手'][1].label, '第二条自动测试消息');
      assert.equal(groundA.sessions['文件传输助手'][2].label, '[图片:220x120]');
      assert.equal(groundA.sessions['文件传输助手'][3].label, '[图片:220x120]');
      assert.match(groundA.sessions['文件传输助手'][4].label, /\[表情:sticker\.gif 88x88\]/);

      // 2. Hard safety gate: non-existent chat session must abort with ZERO items delivered
      await assert.rejects(
        deliverChatSessionVerified(desktop, {
          app: 'AbbWeComSim',
          session: '不存在的外部客户群',
          items: ['绝不能发送的消息'],
        }),
        { code: 'CHAT_TARGET_UNVERIFIED' },
      );
      const groundAfterNeg = JSON.parse(fs.readFileSync(stateA, 'utf8'));
      assert.equal(groundAfterNeg.sessions['文件传输助手'].length, 5, 'Failed target check must not send extra messages');
      assert.equal(groundAfterNeg.sessions['研发技术讨论群'].length, 0);

      // 3. clickTextVerified on custom-drawn canvas
      const clickRes = await clickTextVerified(desktop, {
        app: 'AbbWeComSim',
        text: '部门周报汇总群',
        region: 'sidebar',
      });
      assert.equal(clickRes.ok, true);
      await new Promise(r => setTimeout(r, 100));
      const groundAfterClick = JSON.parse(fs.readFileSync(stateA, 'utf8'));
      assert.equal(groundAfterClick.activeSession, '部门周报汇总群');
    } finally {
      try { childA.kill(); } catch {}
    }

    // 4. Search-only navigation (Ctrl+F -> paste "文件传输助手" -> dropdown hit)
    const stateB = path.join(tmpDir, 'state-b.json');
    const instB = `B_${process.pid}_${Date.now()}`;
    const childB = spawn(simExe, ['--search-only', '--instance', instB, '--state', stateB], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 400));

    try {
      const resB = await deliverChatSessionVerified(desktop, {
        app: 'AbbWeComSim',
        session: '文件传输助手',
        items: [
          '通过搜索快捷键定位会话',
          { type: 'sticker', path: gifFile },
        ],
      });
      assert.equal(resB.ok, true);
      assert.equal(resB.sessionVerified, true);
      assert.ok(
        ['search_dropdown_click', 'search_enter'].includes(resB.navigationMethod),
        `Expected search navigation, got ${resB.navigationMethod}`,
      );
      const groundB = JSON.parse(fs.readFileSync(stateB, 'utf8'));
      assert.equal(groundB.activeSession, '文件传输助手');
      assert.equal(groundB.sessions['研发技术讨论群'].length, 0);
      assert.equal(groundB.sessions['文件传输助手'].length, 2);
    } finally {
      try { childB.kill(); } catch {}
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
