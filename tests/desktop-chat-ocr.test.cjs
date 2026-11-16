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
        } else if (s.command === 'mouse-wheel') {
          results.push({ index: i, command: 'mouse-wheel', execution: 'completed', ok: true, data: {} });
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

test('winHelper.hashImageRegion isolates messages region and deliverChatSessionVerified rejects off-region changes', { skip: process.platform !== 'win32' }, async () => {
  const { execFileSync } = require('node:child_process');
  const winHelper = require('../lib/desktop/winHelper');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-region-hash-'));
  const imgBefore = path.join(tmpDir, 'before.png');
  const imgSidebarDiff = path.join(tmpDir, 'after-sidebar-diff.png');
  const imgMsgDiff = path.join(tmpDir, 'after-msg-diff.png');
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.Drawing;
       function Save-TestPng([string]$p, [System.Drawing.Color]$sideColor, [System.Drawing.Color]$msgColor) {
         $b = New-Object System.Drawing.Bitmap(480, 360);
         $g = [System.Drawing.Graphics]::FromImage($b);
         $g.Clear([System.Drawing.Color]::White);
         $sb = New-Object System.Drawing.SolidBrush($sideColor);
         $mb = New-Object System.Drawing.SolidBrush($msgColor);
         $g.FillRectangle($sb, 10, 10, 40, 40);
         $g.FillRectangle($mb, 240, 180, 40, 40);
         $sb.Dispose(); $mb.Dispose(); $g.Dispose();
         $b.Save($p, [System.Drawing.Imaging.ImageFormat]::Png);
         $b.Dispose();
       }
       Save-TestPng '${imgBefore.replace(/'/g, "''")}' ([System.Drawing.Color]::Black) ([System.Drawing.Color]::Gray);
       Save-TestPng '${imgSidebarDiff.replace(/'/g, "''")}' ([System.Drawing.Color]::Red) ([System.Drawing.Color]::Gray);
       Save-TestPng '${imgMsgDiff.replace(/'/g, "''")}' ([System.Drawing.Color]::Black) ([System.Drawing.Color]::Blue);`,
    ], { windowsHide: true });

    const [hBefore, hSidebarDiff, hMsgDiff] = await Promise.all([
      winHelper.hashImageRegion(imgBefore, { region: 'messages' }),
      winHelper.hashImageRegion(imgSidebarDiff, { region: 'messages' }),
      winHelper.hashImageRegion(imgMsgDiff, { region: 'messages' }),
    ]);
    assert.equal(hBefore.ok, true);
    assert.equal(hBefore.sha256, hSidebarDiff.sha256, 'Messages region hash must ignore pixels outside messages region');
    assert.notEqual(hBefore.sha256, hMsgDiff.sha256, 'Messages region hash must change when transcript pixels change');

    const origOcr = winHelper.ocrImage;
    const origEnsure = winHelper.assistForegroundWindow;
    let shotCall = 0;
    const mockWindow = {
      id: 'w-99901',
      pid: 12345,
      app_name: 'WXWork',
      title: 'WXWork',
      is_focused: true,
      minimized: false,
      bounds: { x: 0, y: 0, width: 480, height: 360 },
    };
    const mockDesktop = {
      adPolicy: () => ({ readOnly: false, mode: 'exclusive' }),
      adInspectCapabilities: async () => ({
        windowId: 'w-99901',
        window: mockWindow,
        mode: 'custom_ui_visual',
        isFocused: true,
        minimized: false,
        bounds: mockWindow.bounds,
      }),
      adListWindows: async () => [mockWindow],
      adFocusWindow: async () => ({ ok: true }),
      adClickAt: async () => ({ ok: true }),
      adPasteText: async () => ({ ok: true }),
      adShortcut: async () => ({ ok: true }),
      adClipboardClear: async () => ({ ok: true }),
      adBatch: async (steps) => {
        const results = steps.map(step => {
          if (step.command === 'screenshot' && step.outputPath) {
            shotCall += 1;
            const src = shotCall === 1 ? imgBefore : imgSidebarDiff;
            fs.copyFileSync(src, step.outputPath);
          }
          return { ok: true, execution: 'completed' };
        });
        return { ok: true, results };
      },
      adScreenshot: async (_opts, outputPath) => {
        const out = typeof outputPath === 'string' ? outputPath : path.join(tmpDir, 'preflight.png');
        fs.copyFileSync(imgBefore, out);
        return { path: out };
      },
    };
    winHelper.assistForegroundWindow = async () => ({
      ok: true,
      focused: true,
      isInteractiveDefaultDesktop: true,
      clampedToWorkArea: false,
    });
    winHelper.ocrImage = async (_img, opts = {}) => ({
      ok: true,
      text: opts.region === 'header' ? '文件传输助手' : '',
      lines: opts.region === 'header'
        ? [{ text: '文件传输助手', x: 160, y: 10, width: 80, height: 20 }]
        : [],
      matches: opts.region === 'header' && opts.find
        ? [{ lineText: '文件传输助手', matchedText: '文件传输助手', matchKind: 'exact', screen: { x: 200, y: 20 } }]
        : [],
    });
    try {
      await assert.rejects(
        deliverChatSessionVerified(mockDesktop, {
          app: 'WeCom',
          windowId: 'w-99901',
          session: '文件传输助手',
          screenshotDir: path.join(tmpDir, 'shots'),
          items: ['offscreen-miss-check'],
        }),
        err => err?.code === 'VISUAL_STATE_UNCHANGED'
          && err?.disposition?.delivery === 'delivered_unverified'
          && err?.disposition?.retry === 'unsafe'
          && /transcript/i.test(err.message),
      );
    } finally {
      winHelper.ocrImage = origOcr;
      winHelper.assistForegroundWindow = origEnsure;
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('ensureWindowReady runs Win32 work-area clamp even when already focused and refreshes bounds', { skip: process.platform !== 'win32' }, async () => {
  const winHelper = require('../lib/desktop/winHelper');
  const { ensureWindowReady } = require('../lib/automation/scenes/desktopWindow');
  const origAssist = winHelper.assistForegroundWindow;
  let assistCalls = 0;
  let currentBounds = { x: -105, y: 849, width: 986, height: 736 };
  const mockDesktop = {
    adPolicy: () => ({ readOnly: false, mode: 'exclusive' }),
    adInspectCapabilities: async () => ({
      windowId: 'w-13699030',
      window: { id: 'w-13699030', pid: 24184, is_focused: true, minimized: false, bounds: currentBounds },
      mode: 'custom_ui_visual',
      isFocused: true,
      minimized: false,
      bounds: currentBounds,
    }),
    adListWindows: async () => ([
      { id: 'w-13699030', pid: 24184, is_focused: true, minimized: false, bounds: currentBounds },
    ]),
    adFocusWindow: async () => ({ ok: true }),
  };
  winHelper.assistForegroundWindow = async () => {
    assistCalls += 1;
    currentBounds = { x: 0, y: 424, width: 986, height: 736 };
    return { ok: true, focused: true, isInteractiveDefaultDesktop: true, clampedToWorkArea: true };
  };
  try {
    const ready = await ensureWindowReady(mockDesktop, { windowId: 'w-13699030', app: 'WeCom' }, { focus: 'auto' });
    assert.equal(assistCalls, 1, 'Should invoke Win32 focus/clamp helper even when already focused');
    assert.ok(ready.actions.includes('move_onscreen'));
    assert.deepEqual(ready.bounds, { x: 0, y: 424, width: 986, height: 736 });
  } finally {
    winHelper.assistForegroundWindow = origAssist;
  }
});

test('win-helper-v3 detectChatLayout detects split-pane + open right drawer and compact OCR cuts payload >80%', { skip: process.platform !== 'win32' }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-layout-v3-'));
  const imgDrawer = path.join(tmpDir, 'chat-with-drawer.png');
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.Drawing;
       $b = New-Object System.Drawing.Bitmap(960, 680);
       $g = [System.Drawing.Graphics]::FromImage($b);
       $g.Clear([System.Drawing.Color]::FromArgb(245, 246, 248));
       $railBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(46, 54, 72));
       $g.FillRectangle($railBrush, 0, 0, 56, 680);
       $chatBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(242, 243, 245));
       $g.FillRectangle($chatBrush, 285, 0, 415, 440);
       $compBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White);
       $g.FillRectangle($compBrush, 285, 440, 415, 240);
       $drawerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(250, 250, 252));
       $g.FillRectangle($drawerBrush, 700, 0, 260, 680);
       $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 224, 230), 1);
       $g.DrawLine($pen, 285, 0, 285, 680);
       $g.DrawLine($pen, 700, 0, 700, 680);
       $g.DrawLine($pen, 285, 440, 700, 440);
       $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit;
       $font = New-Object System.Drawing.Font('Microsoft YaHei', 14, [System.Drawing.FontStyle]::Regular);
       $txtBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 35, 45));
       $rowPrefix = -join ([char[]](0x4f01,0x4e1a,0x5fae,0x4fe1,0x4f1a,0x8bdd,0x5217,0x8868,0x6d4b,0x8bd5,0x6761,0x76ee));
       $targetLabel = -join ([char[]](0x6587,0x4ef6,0x4f20,0x8f93,0x52a9,0x624b));
       for ($i = 0; $i -lt 8; $i++) {
         $g.DrawString(($rowPrefix + $i + ' 10:3' + $i), $font, $txtBrush, 68, (80 + $i * 52));
       }
       $g.DrawString($targetLabel, $font, $txtBrush, 68, 520);
       $pen.Dispose(); $font.Dispose(); $txtBrush.Dispose();
       $railBrush.Dispose(); $chatBrush.Dispose(); $compBrush.Dispose(); $drawerBrush.Dispose();
       $g.Dispose();
       $b.Save('${imgDrawer.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);
       $b.Dispose();`,
    ], { windowsHide: true });

    const layout = await winHelper.detectChatLayout(imgDrawer);
    assert.equal(layout.detected, true);
    assert.ok(Math.abs(layout.sidebarRightX - 285) <= 3, `Expected sidebarRightX ~285, got ${layout.sidebarRightX}`);
    assert.ok(Math.abs(layout.rightDrawerLeftX - 700) <= 3, `Expected rightDrawerLeftX ~700, got ${layout.rightDrawerLeftX}`);
    assert.ok(Math.abs(layout.composerTopY - 440) <= 3, `Expected composerTopY ~440, got ${layout.composerTopY}`);
    // True composer center X must sit inside [285..700] (~492px -> ratio ~0.51), NEVER inside the right drawer (>0.72)!
    assert.ok(layout.composerRatio.xRatio > 0.45 && layout.composerRatio.xRatio < 0.58, `Expected composerRatio.xRatio inside central pane, got ${layout.composerRatio.xRatio}`);

    const bounds = { x: 100, y: 50, width: 960, height: 680 };
    const verboseOcr = await winHelper.ocrImage(imgDrawer, { region: 'sidebar', find: '文件传输助手', bounds, includeWords: true });
    const compactOcr = await winHelper.ocrImage(imgDrawer, { region: 'sidebar', find: '文件传输助手', bounds, includeWords: false, includeLines: false });
    assert.equal(verboseOcr.matches.length, 1);
    assert.equal(compactOcr.matches.length, 1);
    assert.deepEqual(compactOcr.matches[0].screen, verboseOcr.matches[0].screen, 'Sub-line word match coordinates must be identical');
    const verboseBytes = Buffer.byteLength(JSON.stringify(verboseOcr), 'utf8');
    const compactBytes = Buffer.byteLength(JSON.stringify(compactOcr), 'utf8');
    assert.ok(compactBytes < verboseBytes * 0.25, `Expected >75% byte savings: compact=${compactBytes}B vs verbose=${verboseBytes}B`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('deliverChatSessionVerified supports sidebar wheel-scroll fallback, clickTextVerified scrollRetries, and stuck-composer diagnostic', { skip: process.platform !== 'win32' }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-scroll-diag-'));
  const imgInitial = path.join(tmpDir, 'initial.png');
  const imgScrolled = path.join(tmpDir, 'scrolled.png');
  const imgComposerStuck = path.join(tmpDir, 'composer-stuck.png');
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.Drawing;
       function New-ChatPng([string]$p, [bool]$scrolled, [bool]$compDirty) {
         $b = New-Object System.Drawing.Bitmap(480, 360);
         $g = [System.Drawing.Graphics]::FromImage($b);
         $g.Clear([System.Drawing.Color]::White);
         $sb = New-Object System.Drawing.SolidBrush($(if ($scrolled) { [System.Drawing.Color]::Navy } else { [System.Drawing.Color]::Silver }));
         $g.FillRectangle($sb, 12, 120, 80, 40);
         if ($compDirty) {
           $cb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::DarkGreen);
           $g.FillRectangle($cb, 220, 280, 120, 36);
           $cb.Dispose();
         }
         $sb.Dispose(); $g.Dispose();
         $b.Save($p, [System.Drawing.Imaging.ImageFormat]::Png);
         $b.Dispose();
       }
       New-ChatPng '${imgInitial.replace(/'/g, "''")}' $false $false;
       New-ChatPng '${imgScrolled.replace(/'/g, "''")}' $true $false;
       New-ChatPng '${imgComposerStuck.replace(/'/g, "''")}' $true $true;`,
    ], { windowsHide: true });

    const origOcr = winHelper.ocrImage;
    const origAssist = winHelper.assistForegroundWindow;
    let wheelCount = 0;
    let navigated = false;
    const mockWin = {
      id: 'w-88801',
      pid: 22222,
      app_name: 'WXWork',
      title: '企业微信',
      is_focused: true,
      minimized: false,
      bounds: { x: 0, y: 0, width: 480, height: 360 },
    };
    const mockDesktop = {
      adPolicy: () => ({ readOnly: false, mode: 'exclusive' }),
      adInspectCapabilities: async () => ({
        windowId: 'w-88801',
        window: mockWin,
        mode: 'custom_ui_visual',
        isFocused: true,
        minimized: false,
        bounds: mockWin.bounds,
      }),
      adListWindows: async () => [mockWin],
      adFocusWindow: async () => ({ ok: true }),
      adClipboardClear: async () => ({ ok: true }),
      adScreenshot: async (_app, outPath) => {
        fs.copyFileSync(imgInitial, outPath);
        return { path: outPath };
      },
      adMouseWheel: async () => {
        wheelCount += 1;
        return { ok: true };
      },
      adMouseClick: async () => ({ ok: true }),
      adWait: async () => ({ ok: true }),
      adOcrWindow: async (_app, call) => ({
        windowId: 'w-88801',
        matches: wheelCount >= 2 && call.find === '底部历史群'
          ? [{ matchedText: '底部历史群', lineText: '底部历史群', confidence: 'exact', screen: { center: { x: 80, y: 200 } } }]
          : [],
      }),
      adBatch: async (steps) => {
        if (steps.some(s => s.command === 'mouse-wheel')) wheelCount += 1;
        if (steps.some(s => s.command === 'mouse-click' && s.x === 80 && s.y === 200)) navigated = true;
        const isDeliveryBatch = steps.some(s => s.command === 'clipboard-set');
        let shotIdx = 0;
        const results = steps.map(step => {
          if (step.command === 'screenshot' && step.outputPath) {
            shotIdx += 1;
            const src = isDeliveryBatch
              ? (shotIdx === 1 ? imgScrolled : imgComposerStuck)
              : (wheelCount > 0 ? imgScrolled : imgInitial);
            fs.copyFileSync(src, step.outputPath);
          }
          return { ok: true, execution: 'completed' };
        });
        return { ok: true, results, elapsed_ms: 10, transport: 'native-batch-stdin' };
      },
    };

    winHelper.assistForegroundWindow = async () => ({
      ok: true,
      focused: true,
      isInteractiveDefaultDesktop: true,
      clampedToWorkArea: false,
    });
    winHelper.ocrImage = async (shotPath, opts = {}) => {
      const base = path.basename(shotPath);
      if (String(opts.region || '').includes('header')) {
        return {
          imageWidth: 480,
          imageHeight: 360,
          text: navigated ? '底部历史群' : '默认群',
          lines: [{ text: navigated ? '底部历史群' : '默认群' }],
          matches: navigated && opts.find === '底部历史群'
            ? [{ lineText: '底部历史群', matchedText: '底部历史群', screen: { center: { x: 240, y: 24 } }, imageRect: { x: 200, y: 12, width: 80, height: 20 } }]
            : [],
        };
      }
      const hasTargetInSidebar = base.includes('scroll-1');
      return {
        imageWidth: 480,
        imageHeight: 360,
        text: hasTargetInSidebar ? '底部历史群' : '顶部群',
        lines: [{ text: hasTargetInSidebar ? '底部历史群' : '顶部群' }],
        matches: hasTargetInSidebar && opts.find === '底部历史群'
          ? [{ lineText: '底部历史群', matchedText: '底部历史群', confidence: 'exact', imageRect: { x: 40, y: 180, width: 80, height: 20 }, screen: { center: { x: 80, y: 200 } } }]
          : [],
      };
    };

    try {
      // 1. Test sidebar wheel-scroll fallback + stuck-composer diagnostic (messages unchanged, composer changed!)
      await assert.rejects(
        deliverChatSessionVerified(mockDesktop, {
          app: 'wecom',
          windowId: 'w-88801',
          session: '底部历史群',
          allowSearch: false,
          sidebarScrollPages: 2,
          autoDetectLayout: false,
          items: ['unsent-enter-test'],
        }),
        err => err?.code === 'VISUAL_STATE_UNCHANGED'
          && err?.details?.composerChanged === true
          && err?.details?.suggestedSubmitKey === 'ctrl+return'
          && /ctrl\+return/i.test(err.message),
      );
      assert.equal(navigated, true, 'Sidebar scroll fallback should have located and clicked 底部历史群');

      // 2. Test clickTextVerified scrollRetries
      wheelCount = 0;
      const clickRes = await clickTextVerified(mockDesktop, {
        app: 'wecom',
        windowId: 'w-88801',
        text: '底部历史群',
        region: 'sidebar',
        scrollRetries: 3,
        scrollSettleMs: 10,
      });
      assert.equal(clickRes.ok, true);
      assert.equal(clickRes.scrolledAttempts, 2);
    } finally {
      winHelper.ocrImage = origOcr;
      winHelper.assistForegroundWindow = origAssist;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('wechat preset strictly isolates WXWork.exe and folds WinRT CJK radical splits', () => {
  const wechatSpec = appRegistry.resolveAppSpec('wechat');
  const weixinExeSpec = appRegistry.resolveAppSpec('Weixin.exe');
  const wxPathSpec = appRegistry.resolveAppSpec('C:\\Program Files\\Tencent\\Weixin\\Weixin.exe');
  const wecomSpec = appRegistry.resolveAppSpec('wecom');

  const mixedWindows = [
    { id: 'w-wxwork', app_name: 'WXWork.exe', title: '企业微信', is_focused: true, minimized: false, bounds: { x: 100, y: 80, width: 986, height: 736 } },
    { id: 'w-preview', app_name: 'WXWork.exe', title: '预览', is_focused: false, minimized: false, bounds: { x: 120, y: 90, width: 960, height: 640 } },
    { id: 'w-login', app_name: 'Weixin.exe', title: '微信', is_focused: false, minimized: false, bounds: { x: 812, y: 390, width: 296, height: 388 } },
  ];

  for (const spec of [wechatSpec, weixinExeSpec, wxPathSpec]) {
    const matched = appRegistry.matchWindowsList(mixedWindows, spec, {});
    assert.equal(matched.length, 1);
    assert.equal(matched[0].id, 'w-login');
  }

  const onlyWxwork = [mixedWindows[0], mixedWindows[1]];
  assert.equal(appRegistry.matchWindowsList(onlyWxwork, wechatSpec, {}).length, 0);
  assert.equal(
    appRegistry.matchWindowsList([{ id: 'w-chrome', app_name: 'chrome.exe', title: '微信', bounds: { x: 0, y: 0, width: 900, height: 700 } }], wechatSpec, {}).length,
    0,
  );
  assert.equal(
    appRegistry.matchWindowsList(mixedWindows, wechatSpec, { windowId: 'w-wxwork' }).length,
    0,
  );

  const wecomMatched = appRegistry.matchWindowsList(mixedWindows, wecomSpec, {});
  assert.equal(wecomMatched.length, 2);
  assert.ok(wecomMatched.every(w => w.app_name === 'WXWork.exe'));

  assert.equal(winHelper.canonicalOcrKey('文亻牛传输助手'), '文件传输助手');
  assert.equal(winHelper.canonicalOcrKey('文亻制专输助手'), '文件传输助手');
  assert.equal(isStrictHeaderLineMatch('文亻牛传输助手', '文件传输助手'), true);
  assert.equal(isStrictHeaderLineMatch('文亻制专输助手\n佣： 48', '文件传输助手'), true);
  assert.equal(isStrictHeaderLineMatch('文 且力 传 输', '文助传输'), true);
  assert.equal(isStrictHeaderLineMatch('文件传输且力手', '文件传输助手'), true);
  assert.equal(winHelper.canonicalOcrKey('文件传且力手'), '文件传助手');
  assert.equal(isStrictHeaderLineMatch('外部文件传输助手', '文件传输助手'), false);
  assert.equal(isStrictHeaderLineMatch('新研发讨论', '研发讨论'), false);
  assert.equal(isStrictHeaderLineMatch('文件传输群', '文件传输'), false);
  assert.equal(isStrictHeaderLineMatch('陈大亮工作群', '陈小明工作群'), false);
  assert.equal(isStrictHeaderLineMatch('文件传输群', '文件传输助手'), false);
  assert.equal(isStrictHeaderLineMatch('外部研发群', '研发群'), false);

  const splitOcr = {
    imageWidth: 960,
    imageHeight: 680,
    lines: [
      {
        text: '文亻牛传输助手',
        rawText: '文 亻 牛 传 输 助 手',
        x: 70,
        y: 94,
        width: 110,
        height: 16,
        words: [
          { text: '文', x: 70, y: 94, width: 15, height: 16 },
          { text: '亻', x: 85, y: 94, width: 10, height: 16 },
          { text: '牛', x: 95, y: 94, width: 15, height: 16 },
          { text: '传', x: 110, y: 94, width: 17, height: 16 },
          { text: '输', x: 127, y: 94, width: 17, height: 16 },
          { text: '助', x: 144, y: 94, width: 18, height: 16 },
          { text: '手', x: 162, y: 94, width: 18, height: 16 },
        ],
      },
    ],
  };
  const hits = winHelper.findOcrMatches(splitOcr, '文件传输助手', { x: 0, y: 0, width: 960, height: 680 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].distance, 0);
  assert.equal(hits[0].confidence, 'ocr_radical_folded');
});

test('ensureWindowReady auto-enters WeChat 4.x login popup and guards QR-required or readOnly', async () => {
  const loginBounds = { x: 812, y: 390, width: 296, height: 388 };
  const mainBounds = { x: 562, y: 280, width: 796, height: 648 };

  const roDesktop = {
    adPolicy: () => ({ readOnly: true, mode: 'exclusive' }),
    adInspectCapabilities: async () => ({
      windowId: 'w-login',
      minimized: false,
      isFocused: true,
      bounds: loginBounds,
      mode: 'uia_semantic',
      buttonRefs: [{ ref: '@s1:e1', role: 'button', name: '进入微信' }],
    }),
  };
  await assert.rejects(
    ensureWindowReady(roDesktop, { app: 'wechat' }, { focus: true }),
    err => err?.code === 'READ_ONLY_BLOCKED' || err?.code === 'DESKTOP_WINDOW_BOUNDS_INVALID',
  );

  const qrDesktop = {
    adPolicy: () => ({ readOnly: false, mode: 'exclusive' }),
    adInspectCapabilities: async () => ({
      windowId: 'w-login',
      minimized: false,
      isFocused: true,
      bounds: loginBounds,
      mode: 'uia_semantic',
      buttonRefs: [{ ref: '@s1:e2', role: 'button', name: '仅传输文件' }],
    }),
    adFind: async () => ({ match: null }),
  };
  await assert.rejects(
    ensureWindowReady(qrDesktop, { app: 'wechat' }, { focus: true }),
    { code: 'WECHAT_LOGIN_REQUIRED' },
  );

  let entered = false;
  let mainFocused = false;
  const okDesktop = {
    adPolicy: () => ({ readOnly: false, mode: 'exclusive' }),
    adInspectCapabilities: async (_app, call = {}) => {
      if (call.windowId === 'w-main') {
        return {
          windowId: 'w-main',
          window: { id: 'w-main', pid: 1001, app_name: 'Weixin.exe', title: '微信', is_focused: mainFocused, bounds: mainBounds },
          minimized: false,
          isFocused: mainFocused,
          bounds: mainBounds,
          mode: 'custom_ui_visual',
        };
      }
      return {
        windowId: 'w-login',
        window: { id: 'w-login', pid: 1001, app_name: 'Weixin.exe', title: '微信', is_focused: true, bounds: loginBounds },
        minimized: false,
        isFocused: true,
        bounds: loginBounds,
        mode: 'uia_semantic',
        buttonRefs: [{ ref: '@s1:e1', role: 'button', name: '进入微信' }],
      };
    },
    adFocusWindow: async (_app, call = {}) => {
      if (call.windowId === 'w-main') mainFocused = true;
      return { ok: true };
    },
    adPress: async (combo, call = {}) => {
      assert.equal(combo, 'return');
      assert.equal(call.windowId, 'w-login');
      entered = true;
      return { ok: true };
    },
    adListWindows: async () => (entered
      ? [{ id: 'w-main', pid: 1001, app_name: 'Weixin.exe', title: '微信', is_focused: mainFocused, minimized: false, bounds: mainBounds }]
      : [{ id: 'w-login', pid: 1001, app_name: 'Weixin.exe', title: '微信', is_focused: true, minimized: false, bounds: loginBounds }]),
  };
  const ready = await ensureWindowReady(okDesktop, { app: 'wechat' }, { focus: true });
  assert.equal(ready.ready, true);
  assert.equal(ready.windowId, 'w-main');
  assert.ok(ready.actions.includes('enter_login'));
  assert.ok(ready.actions.includes('focus'));

  let mouseClicks = 0;
  let findCalls = 0;
  const timeoutDesktop = {
    adPolicy: () => ({ readOnly: false, mode: 'exclusive' }),
    adInspectCapabilities: async () => ({
      windowId: 'w-login',
      window: { id: 'w-login', pid: 1001, app_name: 'Weixin.exe', title: '微信', is_focused: true, bounds: loginBounds },
      minimized: false,
      isFocused: true,
      bounds: loginBounds,
      mode: 'uia_semantic',
      buttonRefs: [{ ref: '@s1:e1', role: 'button', name: '进入微信' }],
    }),
    adFind: async () => {
      findCalls += 1;
      return { match: null };
    },
    adPress: async () => ({ ok: true }),
    adListWindows: async () => [{ id: 'w-login', pid: 1001, app_name: 'Weixin.exe', title: '微信', is_focused: true, minimized: false, bounds: loginBounds }],
    adMouseClick: async () => {
      mouseClicks += 1;
      return { ok: true };
    },
  };
  await assert.rejects(
    ensureWindowReady(timeoutDesktop, { app: 'wechat' }, { focus: true, launchTimeoutMs: 3900 }),
    err => {
      assert.equal(err?.code, 'WECHAT_LOGIN_TIMEOUT');
      assert.deepEqual(err?.disposition, { delivery: 'not_delivered', retry: 'safe' });
      return true;
    },
  );
  assert.equal(findCalls, 1);
  assert.equal(mouseClicks, 0, 'Must skip 3.5s coordinate click when 进入微信 button is gone');
});

test('launchDetachedViaShell and chat clickMode validate inputs strictly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-shell-guard-'));
  try {
    const batFile = path.join(tmpDir, 'bad.bat');
    fs.writeFileSync(batFile, '@echo off\r\n', 'utf8');
    await assert.rejects(
      winHelper.launchDetachedViaShell(batFile),
      err => err?.code === 'INVALID_ARGS' || err?.code === 'UNSUPPORTED_PLATFORM',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const fakeDesktop = { adOcrWindow: async () => ({}), adBatch: async () => ({}) };
  await assert.rejects(
    clickTextVerified(fakeDesktop, { text: '确定', clickMode: 'invalid' }),
    { code: 'INVALID_ARGS' },
  );
  await assert.rejects(
    deliverChatSessionVerified(fakeDesktop, { app: 'wechat', sessionName: '文件传输助手', clickMode: 'invalid', items: ['hi'] }),
    { code: 'INVALID_ARGS' },
  );
});

test('deliverChatSessionVerified supports navigationMode=keyboard_first with zero mouse clicks', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-kbd-nav-'));
  try {
    const imgInitial = path.join(tmpDir, 'init.png');
    const imgNav = path.join(tmpDir, 'nav.png');
    const imgSent = path.join(tmpDir, 'sent.png');
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Drawing;
       function New-Bmp([string]$p, [System.Drawing.Color]$c) {
         $b = New-Object System.Drawing.Bitmap(480, 360);
         $g = [System.Drawing.Graphics]::FromImage($b);
         $g.Clear([System.Drawing.Color]::White);
         $sb = New-Object System.Drawing.SolidBrush($c);
         $g.FillRectangle($sb, 160, 80, 260, 140);
         $sb.Dispose(); $g.Dispose();
         $b.Save($p, [System.Drawing.Imaging.ImageFormat]::Png);
         $b.Dispose();
       }
       New-Bmp '${imgInitial.replace(/'/g, "''")}' ([System.Drawing.Color]::White);
       New-Bmp '${imgNav.replace(/'/g, "''")}' ([System.Drawing.Color]::WhiteSmoke);
       New-Bmp '${imgSent.replace(/'/g, "''")}' ([System.Drawing.Color]::LightSkyBlue);`,
    ], { windowsHide: true });

    const origOcr = winHelper.ocrImage;
    const origAssist = winHelper.assistForegroundWindow;
    const mouseClicks = [];
    let currentSession = '其他群';

    const mockDesktop = {
      adPolicy: () => ({ readOnly: false, mode: 'exclusive' }),
      adInspectCapabilities: async () => ({
        windowId: 'w-kbd1',
        window: { id: 'w-kbd1', pid: 4444, app_name: 'Weixin.exe', title: '微信', is_focused: true, bounds: { x: 0, y: 0, width: 480, height: 360 } },
        mode: 'custom_ui_visual',
        isFocused: true,
        minimized: false,
        bounds: { x: 0, y: 0, width: 480, height: 360 },
      }),
      adListWindows: async () => [{ id: 'w-kbd1', app_name: 'Weixin.exe', title: '微信', is_focused: true, bounds: { x: 0, y: 0, width: 480, height: 360 } }],
      adClipboardClear: async () => ({ ok: true }),
      adScreenshot: async (_app, outPath) => {
        fs.copyFileSync(imgInitial, outPath);
        return { path: outPath };
      },
      adBatch: async (steps) => {
        for (const s of steps) {
          if (s.command === 'mouse-click') mouseClicks.push(s);
          if (s.command === 'press' && s.combo === 'return') currentSession = '文件传输助手';
        }
        const isDelivery = steps.some(s => s.command === 'clipboard-set') && currentSession === '文件传输助手' && !steps.some(s => s.combo === 'ctrl+f');
        let shotSeq = 0;
        const results = steps.map(s => {
          if (s.command === 'screenshot' && s.outputPath) {
            shotSeq += 1;
            const src = isDelivery ? (shotSeq === 1 ? imgNav : imgSent) : imgNav;
            fs.copyFileSync(src, s.outputPath);
          }
          return { ok: true, execution: 'completed' };
        });
        return { ok: true, results, elapsed_ms: 8, transport: 'native-batch-stdin' };
      },
    };

    winHelper.assistForegroundWindow = async () => ({ ok: true, focused: true, isInteractiveDefaultDesktop: true });
    winHelper.ocrImage = async (_shotPath, opts = {}) => {
      if (String(opts.region || '').includes('messages')) {
        return {
          imageWidth: 480,
          imageHeight: 360,
          text: '键盘优先零鼠标点击实测',
          lines: [{ text: '键盘优先零鼠标点击实测', rawText: '键盘优先零鼠标点击实测', x: 180, y: 120, width: 120, height: 20, words: [] }],
        };
      }
      return {
        imageWidth: 480,
        imageHeight: 360,
        text: currentSession,
        lines: [{ text: currentSession, rawText: currentSession, x: 180, y: 12, width: 100, height: 18, words: [] }],
        matches: opts.find === currentSession
          ? [{ lineText: currentSession, matchedText: currentSession, confidence: 'exact', imageRect: { x: 180, y: 12, width: 100, height: 18 }, screen: { center: { x: 230, y: 21 } } }]
          : [],
      };
    };

    try {
      const res = await deliverChatSessionVerified(mockDesktop, {
        app: 'wechat',
        sessionName: '文件传输助手',
        navigationMode: 'keyboard_first',
        autoDetectLayout: false,
        items: ['键盘优先零鼠标点击实测'],
      });
      assert.equal(res.ok, true);
      assert.equal(res.navigationMethod, 'search_enter');
      assert.equal(mouseClicks.length, 0, 'keyboard_first should perform zero mouse-click steps');
    } finally {
      winHelper.ocrImage = origOcr;
      winHelper.assistForegroundWindow = origAssist;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('winHelper v4 compiles cleanly via csc.exe on Windows', () => {
  assert.equal(winHelper.HELPER_VERSION, 'win-helper-v4');
  const exe = winHelper.ensureWinHelperCompiled();
  assert.ok(fs.existsSync(exe));
});
