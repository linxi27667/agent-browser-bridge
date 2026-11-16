const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { desktopError } = require('./agentDesktopProcess');

const HELPER_VERSION = 'win-helper-v5';

const CSHARP_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

internal static class Program {
  [DllImport("user32.dll")]
  private static extern bool SetProcessDPIAware();

  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentThreadId();

  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentProcessId();

  [DllImport("kernel32.dll")]
  private static extern bool ProcessIdToSessionId(uint dwProcessId, out uint pSessionId);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr GetThreadDesktop(uint dwThreadId);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool CloseDesktop(IntPtr hDesktop);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool GetUserObjectInformationW(
    IntPtr hObj,
    int nIndex,
    StringBuilder pvInfo,
    int nLength,
    out int lpnLengthNeeded
  );

  [DllImport("user32.dll")]
  private static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  private static extern bool AllowSetForegroundWindow(int dwProcessId);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("user32.dll")]
  private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  [DllImport("user32.dll")]
  private static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr FindWindowW(string lpClassName, string lpWindowName);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr FindWindowExW(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("dwmapi.dll")]
  private static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

  private static bool IsWindowCloaked(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return false;
    int cloaked = 0;
    try {
      if (DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0) {
        return cloaked != 0;
      }
    } catch {}
    return false;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
  }

  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MONITORINFO lpmi);

  [DllImport("user32.dll")]
  private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [StructLayout(LayoutKind.Sequential)]
  private struct POINT {
    public int X;
    public int Y;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct SIZE {
    public int cx;
    public int cy;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 1)]
  private struct BLENDFUNCTION {
    public byte BlendOp;
    public byte BlendFlags;
    public byte SourceConstantAlpha;
    public byte AlphaFormat;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct MSG {
    public IntPtr hwnd;
    public uint message;
    public IntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public POINT pt;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct STARTUPINFOW {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [DllImport("user32.dll")]
  private static extern bool GetCursorPos(out POINT lpPoint);

  [DllImport("user32.dll")]
  private static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  private static extern short GetAsyncKeyState(int vKey);

  [DllImport("user32.dll")]
  private static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);

  [DllImport("user32.dll")]
  private static extern IntPtr ChildWindowFromPointEx(IntPtr hwndParent, POINT pt, uint flags);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool PostMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateWindowExW(
    uint dwExStyle,
    string lpClassName,
    string lpWindowName,
    uint dwStyle,
    int x,
    int y,
    int nWidth,
    int nHeight,
    IntPtr hWndParent,
    IntPtr hMenu,
    IntPtr hInstance,
    IntPtr lpParam
  );

  [DllImport("user32.dll")]
  private static extern bool DestroyWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  private static extern bool PeekMessageW(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);

  [DllImport("user32.dll")]
  private static extern bool TranslateMessage(ref MSG lpMsg);

  [DllImport("user32.dll")]
  private static extern IntPtr DispatchMessageW(ref MSG lpMsg);

  [DllImport("user32.dll")]
  private static extern IntPtr GetDC(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

  [DllImport("gdi32.dll")]
  private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

  [DllImport("gdi32.dll")]
  private static extern bool DeleteDC(IntPtr hdc);

  [DllImport("gdi32.dll")]
  private static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);

  [DllImport("gdi32.dll")]
  private static extern bool DeleteObject(IntPtr ho);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool UpdateLayeredWindow(
    IntPtr hwnd,
    IntPtr hdcDst,
    ref POINT pptDst,
    ref SIZE psize,
    IntPtr hdcSrc,
    ref POINT pptSrc,
    uint crKey,
    ref BLENDFUNCTION pblend,
    uint dwFlags
  );

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcessW(
    string lpApplicationName,
    StringBuilder lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFOW lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation
  );

  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr hObject);

  private const int UOI_NAME = 2;
  private const uint DESKTOP_READOBJECTS = 0x0001;
  private const int SW_SHOWNOACTIVATE = 4;
  private const int SW_RESTORE = 9;
  private const int SW_SHOW = 5;
  private const byte VK_MENU = 0x12;
  private const int VK_LBUTTON = 0x01;
  private const int VK_RBUTTON = 0x02;
  private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  private const uint KEYEVENTF_KEYUP = 0x0002;
  private const uint MONITOR_DEFAULTTONEAREST = 2;
  private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  private const uint SWP_NOSIZE = 0x0001;
  private const uint SWP_NOMOVE = 0x0002;
  private const uint SWP_NOZORDER = 0x0004;
  private const uint SWP_NOACTIVATE = 0x0010;
  private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  private const uint MOUSEEVENTF_LEFTUP = 0x0004;
  private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  private const uint WS_POPUP = 0x80000000;
  private const uint WS_EX_TOPMOST = 0x00000008;
  private const uint WS_EX_TRANSPARENT = 0x00000020;
  private const uint WS_EX_TOOLWINDOW = 0x00000080;
  private const uint WS_EX_LAYERED = 0x00080000;
  private const uint WS_EX_NOACTIVATE = 0x08000000;
  private const uint PM_REMOVE = 0x0001;
  private const uint ULW_ALPHA = 0x00000002;
  private const byte AC_SRC_OVER = 0x00;
  private const byte AC_SRC_ALPHA = 0x01;
  private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
  private const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
  private const uint CWP_SKIPINVISIBLE_DISABLED = 0x0003;
  private const uint WM_MOUSEMOVE = 0x0200;
  private const uint WM_LBUTTONDOWN = 0x0201;
  private const uint WM_LBUTTONUP = 0x0202;
  private const uint WM_RBUTTONDOWN = 0x0204;
  private const uint WM_RBUTTONUP = 0x0205;
  private const uint WM_MBUTTONDOWN = 0x0207;
  private const uint WM_MBUTTONUP = 0x0208;

  private static string JsonEscape(string s) {
    if (s == null) return "";
    var sb = new StringBuilder(s.Length + 8);
    foreach (char c in s) {
      switch (c) {
        case '\\': sb.Append("\\\\"); break;
        case '"': sb.Append("\\\""); break;
        case '\r': sb.Append("\\r"); break;
        case '\n': sb.Append("\\n"); break;
        case '\t': sb.Append("\\t"); break;
        default:
          if (c < 0x20) sb.AppendFormat(CultureInfo.InvariantCulture, "\\u{0:x4}", (int)c);
          else sb.Append(c);
          break;
      }
    }
    return sb.ToString();
  }

  private static string GetDesktopName(IntPtr hDesk) {
    if (hDesk == IntPtr.Zero) return "";
    int needed = 0;
    var sb = new StringBuilder(256);
    if (!GetUserObjectInformationW(hDesk, UOI_NAME, sb, sb.Capacity * 2, out needed)) {
      return "";
    }
    return sb.ToString();
  }

  private static int RunEnv() {
    uint sessionId = 0;
    ProcessIdToSessionId(GetCurrentProcessId(), out sessionId);
    string threadDesktop = GetDesktopName(GetThreadDesktop(GetCurrentThreadId()));
    IntPtr hInput = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
    bool inputAccessible = hInput != IntPtr.Zero;
    string inputDesktop = "";
    if (inputAccessible) {
      inputDesktop = GetDesktopName(hInput);
      CloseDesktop(hInput);
    }
    bool isDefault = string.Equals(threadDesktop, "Default", StringComparison.OrdinalIgnoreCase) && sessionId > 0;
    var langs = new List<string>();
    try {
      foreach (var lang in OcrEngine.AvailableRecognizerLanguages) {
        langs.Add("\"" + JsonEscape(lang.LanguageTag) + "\"");
      }
    } catch {}
    Console.Out.WriteLine(
      "{\"ok\":true,\"sessionId\":" + sessionId.ToString(CultureInfo.InvariantCulture)
      + ",\"threadDesktop\":\"" + JsonEscape(threadDesktop) + "\""
      + ",\"inputDesktop\":\"" + JsonEscape(inputDesktop) + "\""
      + ",\"inputDesktopAccessible\":" + (inputAccessible ? "true" : "false")
      + ",\"isInteractiveDefaultDesktop\":" + (isDefault ? "true" : "false")
      + ",\"ocrLanguages\":[" + string.Join(",", langs.ToArray()) + "]}"
    );
    return 0;
  }

  private static string ClassifyImageFormat(ImageFormat fmt) {
    if (ImageFormat.Png.Equals(fmt)) return "png";
    if (ImageFormat.Jpeg.Equals(fmt)) return "jpeg";
    if (ImageFormat.Gif.Equals(fmt)) return "gif";
    if (ImageFormat.Bmp.Equals(fmt) || ImageFormat.MemoryBmp.Equals(fmt)) return "bmp";
    if (ImageFormat.Tiff.Equals(fmt)) return "tiff";
    if (ImageFormat.Icon.Equals(fmt)) return "ico";
    return "other";
  }

  private static int RunToPng(string srcPath, string dstPath) {
    using (var src = Image.FromFile(srcPath)) {
      string srcFmt = ClassifyImageFormat(src.RawFormat);
      int w = src.Width;
      int h = src.Height;
      using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
        using (var g = Graphics.FromImage(bmp)) {
          g.CompositingMode = CompositingMode.SourceCopy;
          g.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g.DrawImage(src, new Rectangle(0, 0, w, h));
        }
        string dir = Path.GetDirectoryName(dstPath);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
        bmp.Save(dstPath, ImageFormat.Png);
      }
      Console.Out.WriteLine(
        "{\"ok\":true,\"width\":" + w.ToString(CultureInfo.InvariantCulture)
        + ",\"height\":" + h.ToString(CultureInfo.InvariantCulture)
        + ",\"sourceFormat\":\"" + JsonEscape(srcFmt) + "\"}"
      );
    }
    return 0;
  }

  private static OcrEngine CreateEngine(string langArg) {
    if (!string.IsNullOrEmpty(langArg) && !string.Equals(langArg, "auto", StringComparison.OrdinalIgnoreCase)) {
      var explicitLang = new Language(langArg);
      if (OcrEngine.IsLanguageSupported(explicitLang)) {
        return OcrEngine.TryCreateFromLanguage(explicitLang);
      }
    }
    foreach (string preferred in new[] { "zh-Hans-CN", "zh-Hans", "zh-CN", "en-US" }) {
      try {
        var lang = new Language(preferred);
        if (OcrEngine.IsLanguageSupported(lang)) {
          var eng = OcrEngine.TryCreateFromLanguage(lang);
          if (eng != null) return eng;
        }
      } catch {}
    }
    var profileEng = OcrEngine.TryCreateFromUserProfileLanguages();
    if (profileEng != null) return profileEng;
    foreach (var avail in OcrEngine.AvailableRecognizerLanguages) {
      var eng = OcrEngine.TryCreateFromLanguage(avail);
      if (eng != null) return eng;
    }
    return null;
  }

  private static T WaitWinRt<T>(IAsyncOperation<T> op) {
    using (var mre = new ManualResetEventSlim(false)) {
      if (op.Status != AsyncStatus.Started) {
        return op.GetResults();
      }
      op.Completed = (info, status) => mre.Set();
      if (op.Status == AsyncStatus.Started) {
        if (!mre.Wait(15000)) {
          throw new TimeoutException("WinRT async operation timed out");
        }
      }
      return op.GetResults();
    }
  }

  private static int RunOcr(string imagePath, string langArg, string cropArg, int scale) {
    var engine = CreateEngine(langArg);
    if (engine == null) {
      Console.Out.WriteLine("{\"ok\":false,\"code\":\"OCR_ENGINE_UNAVAILABLE\",\"message\":\"No Windows OCR language pack is installed\"}");
      return 2;
    }
    if (scale < 1) scale = 1;
    if (scale > 4) scale = 4;

    int fullW = 0, fullH = 0;
    int cropX = 0, cropY = 0, cropW = 0, cropH = 0;
    SoftwareBitmap softwareBitmap = null;

    using (var fullBmp = new Bitmap(imagePath)) {
      fullW = fullBmp.Width;
      fullH = fullBmp.Height;
      cropX = 0;
      cropY = 0;
      cropW = fullW;
      cropH = fullH;

      if (!string.IsNullOrEmpty(cropArg) && cropArg != "-") {
        string[] parts = cropArg.Split(',');
        if (parts.Length == 4) {
          int cx = int.Parse(parts[0], CultureInfo.InvariantCulture);
          int cy = int.Parse(parts[1], CultureInfo.InvariantCulture);
          int cw = int.Parse(parts[2], CultureInfo.InvariantCulture);
          int ch = int.Parse(parts[3], CultureInfo.InvariantCulture);
          cropX = Math.Max(0, Math.Min(fullW - 1, cx));
          cropY = Math.Max(0, Math.Min(fullH - 1, cy));
          cropW = Math.Max(1, Math.Min(fullW - cropX, cw));
          cropH = Math.Max(1, Math.Min(fullH - cropY, ch));
        }
      }

      int targetW = cropW * scale;
      int targetH = cropH * scale;
      while (scale > 1 && (targetW > 4000 || targetH > 4000)) {
        scale -= 1;
        targetW = cropW * scale;
        targetH = cropH * scale;
      }

      byte[] bmpBytes;
      using (var workBmp = new Bitmap(targetW, targetH, PixelFormat.Format32bppArgb)) {
        using (var g = Graphics.FromImage(workBmp)) {
          g.InterpolationMode = scale > 1 ? InterpolationMode.HighQualityBicubic : InterpolationMode.NearestNeighbor;
          g.PixelOffsetMode = PixelOffsetMode.HighQuality;
          g.DrawImage(fullBmp, new Rectangle(0, 0, targetW, targetH), new Rectangle(cropX, cropY, cropW, cropH), GraphicsUnit.Pixel);
        }
        using (var ms = new MemoryStream()) {
          workBmp.Save(ms, ImageFormat.Bmp);
          bmpBytes = ms.ToArray();
        }
      }

      using (var mem = new InMemoryRandomAccessStream()) {
        using (var writer = new DataWriter(mem)) {
          writer.WriteBytes(bmpBytes);
          WaitWinRt(writer.StoreAsync());
          WaitWinRt(writer.FlushAsync());
          writer.DetachStream();
        }
        mem.Seek(0);
        var decoder = WaitWinRt(BitmapDecoder.CreateAsync(mem));
        using (var rawSb = WaitWinRt(decoder.GetSoftwareBitmapAsync())) {
          softwareBitmap = SoftwareBitmap.Convert(rawSb, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        }
      }
    }

    OcrResult ocrResult;
    using (softwareBitmap) {
      ocrResult = WaitWinRt(engine.RecognizeAsync(softwareBitmap));
    }

    double invScale = 1.0 / scale;
    var linesJson = new List<string>();
    foreach (var line in ocrResult.Lines) {
      var wordsJson = new List<string>();
      double minX = double.MaxValue, minY = double.MaxValue, maxR = 0, maxB = 0;
      foreach (var word in line.Words) {
        var r = word.BoundingRect;
        double wx = cropX + r.X * invScale;
        double wy = cropY + r.Y * invScale;
        double ww = Math.Max(1.0, r.Width * invScale);
        double wh = Math.Max(1.0, r.Height * invScale);
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wx + ww > maxR) maxR = wx + ww;
        if (wy + wh > maxB) maxB = wy + wh;
        wordsJson.Add(
          "{\"text\":\"" + JsonEscape(word.Text) + "\""
          + ",\"x\":" + Math.Round(wx, 1).ToString(CultureInfo.InvariantCulture)
          + ",\"y\":" + Math.Round(wy, 1).ToString(CultureInfo.InvariantCulture)
          + ",\"width\":" + Math.Round(ww, 1).ToString(CultureInfo.InvariantCulture)
          + ",\"height\":" + Math.Round(wh, 1).ToString(CultureInfo.InvariantCulture) + "}"
        );
      }
      if (minX == double.MaxValue) { minX = cropX; minY = cropY; maxR = cropX; maxB = cropY; }
      linesJson.Add(
        "{\"rawText\":\"" + JsonEscape(line.Text) + "\""
        + ",\"x\":" + Math.Round(minX, 1).ToString(CultureInfo.InvariantCulture)
        + ",\"y\":" + Math.Round(minY, 1).ToString(CultureInfo.InvariantCulture)
        + ",\"width\":" + Math.Round(Math.Max(0.0, maxR - minX), 1).ToString(CultureInfo.InvariantCulture)
        + ",\"height\":" + Math.Round(Math.Max(0.0, maxB - minY), 1).ToString(CultureInfo.InvariantCulture)
        + ",\"words\":[" + string.Join(",", wordsJson.ToArray()) + "]}"
      );
    }

    string langUsed = engine.RecognizerLanguage != null ? engine.RecognizerLanguage.LanguageTag : "";
    Console.Out.WriteLine(
      "{\"ok\":true,\"language\":\"" + JsonEscape(langUsed) + "\""
      + ",\"imageWidth\":" + fullW.ToString(CultureInfo.InvariantCulture)
      + ",\"imageHeight\":" + fullH.ToString(CultureInfo.InvariantCulture)
      + ",\"crop\":{\"x\":" + cropX + ",\"y\":" + cropY + ",\"width\":" + cropW + ",\"height\":" + cropH + "}"
      + ",\"scale\":" + scale.ToString(CultureInfo.InvariantCulture)
      + ",\"lines\":[" + string.Join(",", linesJson.ToArray()) + "]}"
    );
    return 0;
  }

  private static int RunFocus(string hwndRaw, string pidRaw) {
    string clean = hwndRaw.StartsWith("w-", StringComparison.OrdinalIgnoreCase) ? hwndRaw.Substring(2) : hwndRaw;
    ulong handleVal = ulong.Parse(clean, CultureInfo.InvariantCulture);
    IntPtr hwnd = new IntPtr(unchecked((long)handleVal));
    if (!IsWindow(hwnd)) {
      Console.Out.WriteLine("{\"ok\":false,\"code\":\"WINDOW_NOT_FOUND\",\"message\":\"Window handle is no longer valid\"}");
      return 1;
    }
    uint ownerPid = 0;
    uint targetTid = GetWindowThreadProcessId(hwnd, out ownerPid);
    if (!string.IsNullOrEmpty(pidRaw) && pidRaw != "0") {
      uint expectedPid = uint.Parse(pidRaw, CultureInfo.InvariantCulture);
      if (ownerPid != expectedPid) {
        Console.Out.WriteLine("{\"ok\":false,\"code\":\"WINDOW_NOT_FOUND\",\"message\":\"Window PID changed before focus assist\"}");
        return 1;
      }
    }
    string threadDesktop = GetDesktopName(GetThreadDesktop(GetCurrentThreadId()));
    bool isDefault = string.Equals(threadDesktop, "Default", StringComparison.OrdinalIgnoreCase);
    if (!isDefault) {
      Console.Out.WriteLine("{\"ok\":true,\"focused\":false,\"isInteractiveDefaultDesktop\":false,\"threadDesktop\":\"" + JsonEscape(threadDesktop) + "\"}");
      return 0;
    }

    if (IsIconic(hwnd)) ShowWindowAsync(hwnd, SW_RESTORE);
    else ShowWindowAsync(hwnd, SW_SHOW);

    bool clamped = false;
    RECT wRect;
    if (GetWindowRect(hwnd, out wRect)) {
      IntPtr hMon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
      if (hMon != IntPtr.Zero) {
        MONITORINFO mi = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
        if (GetMonitorInfoW(hMon, ref mi)) {
          RECT work = mi.rcWork;
          int curW = Math.Max(1, wRect.Right - wRect.Left);
          int curH = Math.Max(1, wRect.Bottom - wRect.Top);
          int workW = Math.Max(1, work.Right - work.Left);
          int workH = Math.Max(1, work.Bottom - work.Top);
          int newW = Math.Min(curW, workW);
          int newH = Math.Min(curH, workH);
          int newX = Math.Max(work.Left, Math.Min(wRect.Left, work.Right - newW));
          int newY = Math.Max(work.Top, Math.Min(wRect.Top, work.Bottom - newH));
          if (newX != wRect.Left || newY != wRect.Top || newW != curW || newH != curH) {
            clamped = SetWindowPos(hwnd, IntPtr.Zero, newX, newY, newW, newH, SWP_NOZORDER | SWP_NOACTIVATE);
          }
        }
      }
    }

    if (GetForegroundWindow() == hwnd) {
      Console.Out.WriteLine("{\"ok\":true,\"focused\":true,\"isInteractiveDefaultDesktop\":true,\"clampedToWorkArea\":" + (clamped ? "true" : "false") + "}");
      return 0;
    }

    AllowSetForegroundWindow(-1);
    uint curTid = GetCurrentThreadId();
    IntPtr fg = GetForegroundWindow();
    uint fgPid = 0;
    uint fgTid = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out fgPid) : 0;
    bool attFg = fgTid != 0 && fgTid != curTid && AttachThreadInput(curTid, fgTid, true);
    bool attTarget = targetTid != 0 && targetTid != curTid && targetTid != fgTid && AttachThreadInput(curTid, targetTid, true);
    try {
      BringWindowToTop(hwnd);
      SetForegroundWindow(hwnd);
    } finally {
      if (attTarget) AttachThreadInput(curTid, targetTid, false);
      if (attFg) AttachThreadInput(curTid, fgTid, false);
    }

    for (int i = 0; i < 4; i++) {
      if (GetForegroundWindow() == hwnd) {
        Console.Out.WriteLine("{\"ok\":true,\"focused\":true,\"isInteractiveDefaultDesktop\":true,\"clampedToWorkArea\":" + (clamped ? "true" : "false") + "}");
        return 0;
      }
      Thread.Sleep(20);
    }

    // Unlock Windows ForegroundLockTimeout via neutral Extended-Alt tap
    keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY, UIntPtr.Zero);
    keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, UIntPtr.Zero);
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);

    for (int i = 0; i < 10; i++) {
      if (GetForegroundWindow() == hwnd) {
        Console.Out.WriteLine("{\"ok\":true,\"focused\":true,\"isInteractiveDefaultDesktop\":true,\"clampedToWorkArea\":" + (clamped ? "true" : "false") + "}");
        return 0;
      }
      Thread.Sleep(25);
    }

    // Stronger Win11 Z-order nudge for Qt/Electron popups suppressed behind active IDE windows
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
    SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    for (int i = 0; i < 6; i++) {
      if (GetForegroundWindow() == hwnd) {
        Console.Out.WriteLine("{\"ok\":true,\"focused\":true,\"isInteractiveDefaultDesktop\":true,\"clampedToWorkArea\":" + (clamped ? "true" : "false") + "}");
        return 0;
      }
      Thread.Sleep(20);
    }

    Console.Out.WriteLine("{\"ok\":true,\"focused\":false,\"isInteractiveDefaultDesktop\":true,\"clampedToWorkArea\":" + (clamped ? "true" : "false") + "}");
    return 0;
  }

  private static int RunRegionHash(string imagePath, string cropArg) {
    using (var fullBmp = new Bitmap(imagePath)) {
      int fullW = fullBmp.Width;
      int fullH = fullBmp.Height;
      int cropX = 0, cropY = 0, cropW = fullW, cropH = fullH;
      if (!string.IsNullOrEmpty(cropArg) && cropArg != "-") {
        string[] parts = cropArg.Split(',');
        if (parts.Length == 4) {
          cropX = Math.Max(0, Math.Min(fullW - 1, int.Parse(parts[0], CultureInfo.InvariantCulture)));
          cropY = Math.Max(0, Math.Min(fullH - 1, int.Parse(parts[1], CultureInfo.InvariantCulture)));
          cropW = Math.Max(1, Math.Min(fullW - cropX, int.Parse(parts[2], CultureInfo.InvariantCulture)));
          cropH = Math.Max(1, Math.Min(fullH - cropY, int.Parse(parts[3], CultureInfo.InvariantCulture)));
        }
      }
      using (var cropBmp = new Bitmap(cropW, cropH, PixelFormat.Format32bppArgb)) {
        using (var g = Graphics.FromImage(cropBmp)) {
          g.CompositingMode = CompositingMode.SourceCopy;
          g.DrawImage(fullBmp, new Rectangle(0, 0, cropW, cropH), new Rectangle(cropX, cropY, cropW, cropH), GraphicsUnit.Pixel);
        }
        var bd = cropBmp.LockBits(new Rectangle(0, 0, cropW, cropH), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try {
          int byteLen = Math.Abs(bd.Stride) * cropH;
          byte[] buf = new byte[byteLen];
          Marshal.Copy(bd.Scan0, buf, 0, byteLen);
          using (var sha = SHA256.Create()) {
            byte[] digest = sha.ComputeHash(buf);
            var hex = new StringBuilder(digest.Length * 2);
            foreach (byte b in digest) hex.AppendFormat(CultureInfo.InvariantCulture, "{0:x2}", b);
            Console.Out.WriteLine("{\"ok\":true,\"sha256\":\"" + hex.ToString() + "\",\"width\":" + cropW + ",\"height\":" + cropH + "}");
          }
        } finally {
          cropBmp.UnlockBits(bd);
        }
      }
    }
    return 0;
  }

  private static int MaxDiff(byte[] buf, int idxA, int idxB) {
    int db = Math.Abs(buf[idxA] - buf[idxB]);
    int dg = Math.Abs(buf[idxA + 1] - buf[idxB + 1]);
    int dr = Math.Abs(buf[idxA + 2] - buf[idxB + 2]);
    return Math.Max(dr, Math.Max(dg, db));
  }

  private static int RunChatLayout(string imagePath) {
    using (var rawBmp = new Bitmap(imagePath)) {
      int w = rawBmp.Width;
      int h = rawBmp.Height;
      if (w < 320 || h < 240) {
        Console.Out.WriteLine("{\"ok\":true,\"detected\":false,\"width\":" + w + ",\"height\":" + h + "}");
        return 0;
      }
      using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
        using (var g = Graphics.FromImage(bmp)) {
          g.CompositingMode = CompositingMode.SourceCopy;
          g.DrawImage(rawBmp, new Rectangle(0, 0, w, h));
        }
        var bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        int stride = Math.Abs(bd.Stride);
        byte[] buf = new byte[stride * h];
        try {
          Marshal.Copy(bd.Scan0, buf, 0, buf.Length);
        } finally {
          bmp.UnlockBits(bd);
        }

        int yStart = Math.Max(4, (int)(h * 0.12));
        int yEnd = Math.Min(h - 4, (int)(h * 0.88));
        int ySamples = Math.Max(1, (yEnd - yStart + 1) / 2);

        int sidebarRightX = -1;
        double bestSidebarScore = 0.0;
        int sbMinX = Math.Max(4, (int)(w * 0.16));
        int sbMaxX = Math.Min(w - 5, (int)(w * 0.44));
        for (int x = sbMinX; x <= sbMaxX; x++) {
          int edgeHits = 0;
          int uniformHits = 0;
          for (int y = yStart; y < yEnd; y += 2) {
            int row = y * stride;
            int idx = row + x * 4;
            int dLeft = MaxDiff(buf, idx, idx - 8);
            int dRight = MaxDiff(buf, idx, idx + 8);
            int dSpan = MaxDiff(buf, idx - 8, idx + 8);
            if (dLeft >= 5 || dRight >= 5 || dSpan >= 7) edgeHits++;
            if (MaxDiff(buf, idx, (y - 2) * stride + x * 4) <= 3) uniformHits++;
          }
          double edgeRatio = (double)edgeHits / ySamples;
          double uniformRatio = (double)uniformHits / ySamples;
          if (edgeRatio >= 0.55 && uniformRatio >= 0.70) {
            double score = edgeRatio * 0.6 + uniformRatio * 0.4;
            if (score > bestSidebarScore) {
              bestSidebarScore = score;
              sidebarRightX = x;
            }
          }
        }

        int rightDrawerLeftX = -1;
        double bestDrawerScore = 0.0;
        int drMinX = Math.Max(sidebarRightX > 0 ? sidebarRightX + (int)(w * 0.20) : (int)(w * 0.56), (int)(w * 0.56));
        int drMaxX = Math.Min(w - 5, (int)(w * 0.88));
        for (int x = drMinX; x <= drMaxX; x++) {
          int edgeHits = 0;
          int uniformHits = 0;
          for (int y = yStart; y < yEnd; y += 2) {
            int row = y * stride;
            int idx = row + x * 4;
            int dLeft = MaxDiff(buf, idx, idx - 8);
            int dRight = MaxDiff(buf, idx, idx + 8);
            int dSpan = MaxDiff(buf, idx - 8, idx + 8);
            if (dLeft >= 5 || dRight >= 5 || dSpan >= 7) edgeHits++;
            if (MaxDiff(buf, idx, (y - 2) * stride + x * 4) <= 3) uniformHits++;
          }
          double edgeRatio = (double)edgeHits / ySamples;
          double uniformRatio = (double)uniformHits / ySamples;
          if (edgeRatio >= 0.62 && uniformRatio >= 0.74) {
            double score = edgeRatio * 0.6 + uniformRatio * 0.4;
            if (score > bestDrawerScore) {
              bestDrawerScore = score;
              rightDrawerLeftX = x;
            }
          }
        }

        int chatLeft = sidebarRightX > 0 ? sidebarRightX : (int)(w * 0.28);
        int chatRight = rightDrawerLeftX > 0 ? rightDrawerLeftX : w;
        int composerTopY = -1;
        double bestCompScore = 0.0;
        int xStart = Math.Min(w - 6, chatLeft + 16);
        int xEnd = Math.Max(xStart + 2, chatRight - 16);
        int xSamples = Math.Max(1, (xEnd - xStart + 1) / 2);
        if (xEnd - xStart >= 80) {
          int cyMin = Math.Max(4, (int)(h * 0.52));
          int cyMax = Math.Min(h - 5, (int)(h * 0.86));
          for (int y = cyMin; y <= cyMax; y++) {
            int row = y * stride;
            int upRow = (y - 2) * stride;
            int dnRow = (y + 2) * stride;
            int edgeHits = 0;
            int uniformHits = 0;
            for (int x = xStart; x < xEnd; x += 2) {
              int off = x * 4;
              int dUp = MaxDiff(buf, row + off, upRow + off);
              int dDn = MaxDiff(buf, row + off, dnRow + off);
              int dSpan = MaxDiff(buf, upRow + off, dnRow + off);
              if (dUp >= 5 || dDn >= 5 || dSpan >= 7) edgeHits++;
              if (MaxDiff(buf, row + off, row + off - 8) <= 3) uniformHits++;
            }
            double edgeRatio = (double)edgeHits / xSamples;
            double uniformRatio = (double)uniformHits / xSamples;
            if (edgeRatio >= 0.58 && uniformRatio >= 0.70) {
              double score = edgeRatio * 0.6 + uniformRatio * 0.4;
              if (score > bestCompScore) {
                bestCompScore = score;
                composerTopY = y;
              }
            }
          }
        }

        bool detected = sidebarRightX > 0 || rightDrawerLeftX > 0 || composerTopY > 0;
        Console.Out.WriteLine(
          "{\"ok\":true,\"detected\":" + (detected ? "true" : "false")
          + ",\"width\":" + w.ToString(CultureInfo.InvariantCulture)
          + ",\"height\":" + h.ToString(CultureInfo.InvariantCulture)
          + ",\"sidebarRightX\":" + sidebarRightX.ToString(CultureInfo.InvariantCulture)
          + ",\"rightDrawerLeftX\":" + rightDrawerLeftX.ToString(CultureInfo.InvariantCulture)
          + ",\"composerTopY\":" + composerTopY.ToString(CultureInfo.InvariantCulture) + "}"
        );
      }
    }
    return 0;
  }

  private static bool IsInteractiveDefaultDesktop(out string desktopName) {
    uint sessionId = 0;
    ProcessIdToSessionId(GetCurrentProcessId(), out sessionId);
    desktopName = GetDesktopName(GetThreadDesktop(GetCurrentThreadId()));
    return string.Equals(desktopName, "Default", StringComparison.OrdinalIgnoreCase) && sessionId > 0;
  }

  private static bool TryParseWindowHandle(string hwndRaw, out IntPtr hwnd) {
    hwnd = IntPtr.Zero;
    if (string.IsNullOrEmpty(hwndRaw)) return false;
    string clean = hwndRaw.StartsWith("w-", StringComparison.OrdinalIgnoreCase) ? hwndRaw.Substring(2) : hwndRaw;
    ulong handleVal;
    if (!ulong.TryParse(clean, NumberStyles.Integer, CultureInfo.InvariantCulture, out handleVal)) return false;
    hwnd = new IntPtr(unchecked((long)handleVal));
    return hwnd != IntPtr.Zero && IsWindow(hwnd);
  }

  private static string QuoteWin32Arg(string arg) {
    if (string.IsNullOrEmpty(arg)) return "\"\"";
    if (arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
    var sb = new StringBuilder();
    sb.Append('"');
    for (int i = 0; i < arg.Length; i++) {
      int numBackslashes = 0;
      while (i < arg.Length && arg[i] == '\\') {
        numBackslashes++;
        i++;
      }
      if (i == arg.Length) {
        sb.Append('\\', numBackslashes * 2);
        break;
      }
      if (arg[i] == '"') {
        sb.Append('\\', numBackslashes * 2 + 1);
        sb.Append('"');
      } else {
        sb.Append('\\', numBackslashes);
        sb.Append(arg[i]);
      }
    }
    sb.Append('"');
    return sb.ToString();
  }

  private static int RunShellLaunch(string exePath, string cwd, string[] extraArgs) {
    string desktopName;
    bool isDefaultDesktop = IsInteractiveDefaultDesktop(out desktopName);
    if (string.IsNullOrEmpty(exePath) || !File.Exists(exePath)) {
      Console.Out.WriteLine("{\"ok\":false,\"code\":\"APP_EXECUTABLE_NOT_FOUND\",\"message\":\"Target executable path does not exist\"}");
      return 1;
    }
    if (!exePath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) {
      Console.Out.WriteLine("{\"ok\":false,\"code\":\"INVALID_ARGS\",\"message\":\"Target must be a .exe file\"}");
      return 1;
    }
    string workDir = (!string.IsNullOrEmpty(cwd) && Directory.Exists(cwd)) ? cwd : Path.GetDirectoryName(exePath);
    var argParts = new List<string>();
    if (extraArgs != null) {
      foreach (string a in extraArgs) argParts.Add(QuoteWin32Arg(a));
    }
    string joinedArgs = string.Join(" ", argParts.ToArray());

    int shellOk = 0;
    string shellErrMsg = null;
    bool staTimedOut = false;
    if (isDefaultDesktop) {
      Thread sta = new Thread(() => {
        object shellObj = null;
        try {
          Type shellType = Type.GetTypeFromProgID("Shell.Application");
          if (shellType != null) {
            shellObj = Activator.CreateInstance(shellType);
            shellType.InvokeMember(
              "ShellExecute",
              BindingFlags.InvokeMethod,
              null,
              shellObj,
              new object[] { exePath, joinedArgs, workDir ?? "", "open", 1 }
            );
            Interlocked.Exchange(ref shellOk, 1);
          }
        } catch (Exception ex) {
          Interlocked.Exchange(ref shellErrMsg, ex.Message);
        } finally {
          if (shellObj != null && Marshal.IsComObject(shellObj)) {
            try { Marshal.FinalReleaseComObject(shellObj); } catch {}
          }
        }
      });
      sta.IsBackground = true;
      sta.SetApartmentState(ApartmentState.STA);
      sta.Start();
      if (!sta.Join(5000)) {
        staTimedOut = true;
      }
    }

    if (Interlocked.CompareExchange(ref shellOk, 0, 0) == 1) {
      Console.Out.WriteLine("{\"ok\":true,\"method\":\"explorer-shell\"}");
      return 0;
    }
    if (isDefaultDesktop && staTimedOut) {
      Console.Out.WriteLine("{\"ok\":false,\"code\":\"WIN_HELPER_FAILED\",\"message\":\"Explorer ShellExecute timed out after 5000ms\"}");
      return 1;
    }

    string cmdText = QuoteWin32Arg(exePath) + (string.IsNullOrEmpty(joinedArgs) ? "" : (" " + joinedArgs));
    STARTUPINFOW si = new STARTUPINFOW { cb = Marshal.SizeOf(typeof(STARTUPINFOW)), dwFlags = 1, wShowWindow = 1 };
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    string method = "create-process-breakaway";
    bool launched = CreateProcessW(
      exePath,
      new StringBuilder(cmdText),
      IntPtr.Zero,
      IntPtr.Zero,
      false,
      CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP,
      IntPtr.Zero,
      workDir,
      ref si,
      out pi
    );
    if (!launched && Marshal.GetLastWin32Error() == 5) {
      method = "create-process";
      launched = CreateProcessW(
        exePath,
        new StringBuilder(cmdText),
        IntPtr.Zero,
        IntPtr.Zero,
        false,
        CREATE_NEW_PROCESS_GROUP,
        IntPtr.Zero,
        workDir,
        ref si,
        out pi
      );
    }
    if (!launched) {
      int err = Marshal.GetLastWin32Error();
      string fallbackDetail = shellErrMsg != null ? (" | shellErr: " + shellErrMsg) : "";
      Console.Out.WriteLine(
        "{\"ok\":false,\"code\":\"WIN_HELPER_FAILED\",\"message\":\"Failed to launch process (win32="
        + err.ToString(CultureInfo.InvariantCulture) + JsonEscape(fallbackDetail) + ")\"}"
      );
      return 1;
    }
    uint launchedPid = pi.dwProcessId;
    if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
    if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
    Console.Out.WriteLine("{\"ok\":true,\"method\":\"" + method + "\",\"pid\":" + launchedPid.ToString(CultureInfo.InvariantCulture) + "}");
    return 0;
  }

  private static Color ParseHexColor(string hex, Color fallback) {
    if (string.IsNullOrEmpty(hex)) return fallback;
    string clean = hex.StartsWith("#", StringComparison.Ordinal) ? hex.Substring(1) : hex;
    if (clean.Length != 6) return fallback;
    int val;
    if (!int.TryParse(clean, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out val)) return fallback;
    return Color.FromArgb(255, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF);
  }

  private static int RunRipple(int cx, int cy, int durationMs, string colorHex) {
    string desktopName;
    if (!IsInteractiveDefaultDesktop(out desktopName)) {
      Console.Out.WriteLine("{\"ok\":true,\"skipped\":true}");
      return 0;
    }
    if (durationMs < 80) durationMs = 80;
    if (durationMs > 1200) durationMs = 1200;
    const int size = 96;
    int left = cx - size / 2;
    int top = cy - size / 2;
    Color baseColor = ParseHexColor(colorHex, Color.FromArgb(255, 14, 165, 233));

    IntPtr hwnd = CreateWindowExW(
      WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      "Static",
      "",
      WS_POPUP,
      left,
      top,
      size,
      size,
      IntPtr.Zero,
      IntPtr.Zero,
      IntPtr.Zero,
      IntPtr.Zero
    );
    if (hwnd == IntPtr.Zero) {
      Console.Out.WriteLine("{\"ok\":true,\"skipped\":true}");
      return 0;
    }

    IntPtr screenDc = IntPtr.Zero;
    IntPtr memDc = IntPtr.Zero;
    try {
      screenDc = GetDC(IntPtr.Zero);
      memDc = CreateCompatibleDC(screenDc);
      if (memDc == IntPtr.Zero) {
        Console.Out.WriteLine("{\"ok\":true,\"skipped\":true}");
        return 0;
      }
      POINT dstPt = new POINT { X = left, Y = top };
      SIZE winSz = new SIZE { cx = size, cy = size };
      POINT srcPt = new POINT { X = 0, Y = 0 };
      BLENDFUNCTION blend = new BLENDFUNCTION {
        BlendOp = AC_SRC_OVER,
        BlendFlags = 0,
        SourceConstantAlpha = 255,
        AlphaFormat = AC_SRC_ALPHA,
      };
      int frames = Math.Max(6, durationMs / 25);
      int stepMs = Math.Max(16, durationMs / frames);

      using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppPArgb))
      using (var g = Graphics.FromImage(bmp)) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        for (int f = 0; f <= frames; f++) {
          double t = (double)f / frames;
          double ease = 1.0 - Math.Pow(1.0 - t, 2.0);
          float radius = (float)(8.0 + 32.0 * ease);
          int ringAlpha = Math.Max(0, Math.Min(230, (int)Math.Round(225.0 * Math.Pow(1.0 - t, 1.4))));
          int dotAlpha = Math.Max(0, Math.Min(230, (int)Math.Round(210.0 * Math.Max(0.0, 1.0 - t * 1.6))));

          g.Clear(Color.Transparent);
          if (ringAlpha > 0) {
            using (var pen = new Pen(Color.FromArgb(ringAlpha, baseColor.R, baseColor.G, baseColor.B), 2.8f)) {
              g.DrawEllipse(pen, size / 2f - radius, size / 2f - radius, radius * 2f, radius * 2f);
            }
          }
          if (dotAlpha > 0) {
            using (var br = new SolidBrush(Color.FromArgb(dotAlpha, baseColor.R, baseColor.G, baseColor.B))) {
              g.FillEllipse(br, size / 2f - 3.5f, size / 2f - 3.5f, 7.0f, 7.0f);
            }
          }

          IntPtr hBmp = IntPtr.Zero;
          IntPtr oldBmp = IntPtr.Zero;
          try {
            hBmp = bmp.GetHbitmap(Color.FromArgb(0));
            oldBmp = SelectObject(memDc, hBmp);
            UpdateLayeredWindow(hwnd, screenDc, ref dstPt, ref winSz, memDc, ref srcPt, 0, ref blend, ULW_ALPHA);
          } finally {
            if (oldBmp != IntPtr.Zero) SelectObject(memDc, oldBmp);
            if (hBmp != IntPtr.Zero) DeleteObject(hBmp);
          }
          if (f == 0) ShowWindow(hwnd, SW_SHOWNOACTIVATE);

          MSG msg;
          while (PeekMessageW(out msg, hwnd, 0, 0, PM_REMOVE)) {
            TranslateMessage(ref msg);
            DispatchMessageW(ref msg);
          }
          if (f < frames) Thread.Sleep(stepMs);
        }
      }
      Console.Out.WriteLine("{\"ok\":true,\"rendered\":true}");
      return 0;
    } finally {
      if (memDc != IntPtr.Zero) DeleteDC(memDc);
      if (screenDc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screenDc);
      DestroyWindow(hwnd);
    }
  }

  private static int RunCursorPrep(int humanGuardMs) {
    if (humanGuardMs < 0) humanGuardMs = 0;
    if (humanGuardMs > 3000) humanGuardMs = 3000;
    string desktopName;
    if (!IsInteractiveDefaultDesktop(out desktopName)) {
      Console.Out.WriteLine("{\"ok\":true,\"skipped\":true,\"x\":0,\"y\":0,\"humanYieldMs\":0}");
      return 0;
    }
    var sw = Stopwatch.StartNew();
    POINT p0;
    GetCursorPos(out p0);
    int yielded = 0;
    if (humanGuardMs > 0) {
      Thread.Sleep(Math.Min(55, humanGuardMs));
      while (sw.ElapsedMilliseconds < humanGuardMs) {
        POINT pNow;
        GetCursorPos(out pNow);
        bool moving = Math.Abs(pNow.X - p0.X) > 6 || Math.Abs(pNow.Y - p0.Y) > 6;
        bool btnDown = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0 || (GetAsyncKeyState(VK_RBUTTON) & 0x8000) != 0;
        if (!moving && !btnDown) break;
        p0 = pNow;
        int slice = (int)Math.Min(70, Math.Max(15, humanGuardMs - sw.ElapsedMilliseconds));
        Thread.Sleep(slice);
        yielded = (int)sw.ElapsedMilliseconds;
      }
    }
    POINT saved;
    GetCursorPos(out saved);
    Console.Out.WriteLine(
      "{\"ok\":true,\"x\":" + saved.X.ToString(CultureInfo.InvariantCulture)
      + ",\"y\":" + saved.Y.ToString(CultureInfo.InvariantCulture)
      + ",\"humanYieldMs\":" + yielded.ToString(CultureInfo.InvariantCulture) + "}"
    );
    return 0;
  }

  private static int RunCursorRestore(int x, int y, int settleMs) {
    string desktopName;
    if (!IsInteractiveDefaultDesktop(out desktopName)) {
      Console.Out.WriteLine("{\"ok\":true,\"skipped\":true}");
      return 0;
    }
    if (settleMs > 0 && settleMs <= 500) Thread.Sleep(settleMs);
    SetCursorPos(x, y);
    Console.Out.WriteLine(
      "{\"ok\":true,\"restored\":{\"x\":" + x.ToString(CultureInfo.InvariantCulture)
      + ",\"y\":" + y.ToString(CultureInfo.InvariantCulture) + "}}"
    );
    return 0;
  }

  private static int RunPostClick(string hwndRaw, int screenX, int screenY, string button, int count) {
    IntPtr hwnd;
    if (!TryParseWindowHandle(hwndRaw, out hwnd)) {
      Console.Out.WriteLine("{\"ok\":false,\"code\":\"WINDOW_NOT_FOUND\",\"message\":\"Window handle is no longer valid\"}");
      return 1;
    }
    IntPtr target = hwnd;
    POINT screenPt = new POINT { X = screenX, Y = screenY };
    for (int depth = 0; depth < 8; depth++) {
      POINT clientPt = screenPt;
      if (!ScreenToClient(target, ref clientPt)) break;
      IntPtr child = ChildWindowFromPointEx(target, clientPt, CWP_SKIPINVISIBLE_DISABLED);
      if (child == IntPtr.Zero || child == target) break;
      target = child;
    }
    POINT finalPt = screenPt;
    if (!ScreenToClient(target, ref finalPt)) {
      Console.Out.WriteLine("{\"ok\":false,\"code\":\"WIN_HELPER_FAILED\",\"message\":\"Failed to map screen coordinates to client window\"}");
      return 1;
    }
    IntPtr lParam = new IntPtr(((finalPt.Y & 0xFFFF) << 16) | (finalPt.X & 0xFFFF));
    uint downMsg = WM_LBUTTONDOWN;
    uint upMsg = WM_LBUTTONUP;
    IntPtr wParamDown = new IntPtr(1);
    if (string.Equals(button, "right", StringComparison.OrdinalIgnoreCase)) {
      downMsg = WM_RBUTTONDOWN;
      upMsg = WM_RBUTTONUP;
      wParamDown = new IntPtr(2);
    } else if (string.Equals(button, "middle", StringComparison.OrdinalIgnoreCase)) {
      downMsg = WM_MBUTTONDOWN;
      upMsg = WM_MBUTTONUP;
      wParamDown = new IntPtr(16);
    }
    if (count < 1) count = 1;
    if (count > 3) count = 3;
    bool anyDownDispatched = false;
    if (!PostMessageW(target, WM_MOUSEMOVE, IntPtr.Zero, lParam)) {
      int err = Marshal.GetLastWin32Error();
      Console.Out.WriteLine(
        "{\"ok\":false,\"code\":\"ACTION_FAILED\",\"dispatched\":false,\"message\":\"PostMessageW mouse move failed (win32="
        + err.ToString(CultureInfo.InvariantCulture) + ")\"}"
      );
      return 1;
    }
    for (int i = 0; i < count; i++) {
      if (!PostMessageW(target, downMsg, wParamDown, lParam)) {
        int err = Marshal.GetLastWin32Error();
        Console.Out.WriteLine(
          "{\"ok\":false,\"code\":\"ACTION_FAILED\",\"dispatched\":"
          + (anyDownDispatched ? "true" : "false")
          + ",\"message\":\"PostMessageW mouse down failed (win32="
          + err.ToString(CultureInfo.InvariantCulture) + ")\"}"
        );
        return 1;
      }
      anyDownDispatched = true;
      Thread.Sleep(10);
      if (!PostMessageW(target, upMsg, IntPtr.Zero, lParam)) {
        int err = Marshal.GetLastWin32Error();
        Console.Out.WriteLine(
          "{\"ok\":false,\"code\":\"ACTION_FAILED\",\"dispatched\":true,\"message\":\"PostMessageW mouse up failed (win32="
          + err.ToString(CultureInfo.InvariantCulture) + ")\"}"
        );
        return 1;
      }
      if (i + 1 < count) Thread.Sleep(20);
    }
    Console.Out.WriteLine(
      "{\"ok\":true,\"method\":\"post_message\",\"clientX\":" + finalPt.X.ToString(CultureInfo.InvariantCulture)
      + ",\"clientY\":" + finalPt.Y.ToString(CultureInfo.InvariantCulture)
      + ",\"count\":" + count.ToString(CultureInfo.InvariantCulture) + "}"
    );
    return 0;
  }

  private static void PerformClickAt(int x, int y, string button, int count, int settleMs) {
    uint downFlag = MOUSEEVENTF_LEFTDOWN;
    uint upFlag = MOUSEEVENTF_LEFTUP;
    if (string.Equals(button, "right", StringComparison.OrdinalIgnoreCase)) {
      downFlag = MOUSEEVENTF_RIGHTDOWN;
      upFlag = MOUSEEVENTF_RIGHTUP;
    } else if (string.Equals(button, "middle", StringComparison.OrdinalIgnoreCase)) {
      downFlag = MOUSEEVENTF_MIDDLEDOWN;
      upFlag = MOUSEEVENTF_MIDDLEUP;
    }
    if (count < 1) count = 1;
    if (count > 3) count = 3;
    SetCursorPos(x, y);
    Thread.Sleep(3);
    for (int i = 0; i < count; i++) {
      mouse_event(downFlag, 0, 0, 0, UIntPtr.Zero);
      Thread.Sleep(10);
      mouse_event(upFlag, 0, 0, 0, UIntPtr.Zero);
      if (i + 1 < count) Thread.Sleep(18);
    }
    if (settleMs > 0) Thread.Sleep(settleMs);
  }

  private static int RunClickAndRestore(int x, int y, string button, int count, int restore, int humanGuardMs, int settleMs) {
    string desktopName;
    if (!IsInteractiveDefaultDesktop(out desktopName)) {
      Console.Out.WriteLine("{\"ok\":false,\"code\":\"DESKTOP_SANDBOX_ISOLATED\",\"message\":\"Physical mouse input is unavailable outside WinSta0\\\\Default\"}");
      return 1;
    }
    if (humanGuardMs < 0) humanGuardMs = 0;
    if (humanGuardMs > 3000) humanGuardMs = 3000;
    if (settleMs < 0) settleMs = 0;
    if (settleMs > 500) settleMs = 500;

    var sw = Stopwatch.StartNew();
    POINT p0;
    GetCursorPos(out p0);
    int yielded = 0;
    if (humanGuardMs > 0) {
      Thread.Sleep(Math.Min(20, humanGuardMs));
      while (sw.ElapsedMilliseconds < humanGuardMs) {
        POINT pNow;
        GetCursorPos(out pNow);
        bool moving = Math.Abs(pNow.X - p0.X) > 6 || Math.Abs(pNow.Y - p0.Y) > 6;
        bool btnDown = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0 || (GetAsyncKeyState(VK_RBUTTON) & 0x8000) != 0;
        if (!moving && !btnDown) break;
        p0 = pNow;
        int slice = (int)Math.Min(60, Math.Max(15, humanGuardMs - sw.ElapsedMilliseconds));
        Thread.Sleep(slice);
        yielded = (int)sw.ElapsedMilliseconds;
      }
    }

    POINT saved;
    GetCursorPos(out saved);
    var clickSw = Stopwatch.StartNew();
    PerformClickAt(x, y, button, count, restore != 0 ? settleMs : 0);
    if (restore != 0) {
      SetCursorPos(saved.X, saved.Y);
    }
    long awayMs = clickSw.ElapsedMilliseconds;
    Console.Out.WriteLine(
      "{\"ok\":true,\"clicked\":{\"x\":" + x.ToString(CultureInfo.InvariantCulture)
      + ",\"y\":" + y.ToString(CultureInfo.InvariantCulture) + "}"
      + ",\"restored\":" + (restore != 0 ? "true" : "false")
      + ",\"saved\":{\"x\":" + saved.X.ToString(CultureInfo.InvariantCulture) + ",\"y\":" + saved.Y.ToString(CultureInfo.InvariantCulture) + "}"
      + ",\"awayMs\":" + awayMs.ToString(CultureInfo.InvariantCulture)
      + ",\"humanYieldMs\":" + yielded.ToString(CultureInfo.InvariantCulture) + "}"
    );
    return 0;
  }

  private static int RunFindProc(string namesCsv) {
    uint mySession = 0;
    ProcessIdToSessionId(GetCurrentProcessId(), out mySession);
    var targets = new List<string>();
    var seenTargets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (string raw in (namesCsv ?? "").Split(',')) {
      string clean = raw.Trim();
      if (clean.Length == 0) continue;
      if (clean.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) clean = clean.Substring(0, clean.Length - 4);
      if (clean.Length > 0 && seenTargets.Add(clean)) targets.Add(clean);
    }
    int count = 0;
    int bestPid = 0;
    string bestPath = "";
    var byExeJson = new List<string>();
    foreach (string stem in targets) {
      Process[] procs = null;
      try { procs = Process.GetProcessesByName(stem); } catch { procs = null; }
      if (procs == null) continue;
      int stemCount = 0;
      int stemPid = 0;
      string stemPath = "";
      foreach (var p in procs) {
        try {
          uint pSession = 0;
          try { pSession = (uint)p.SessionId; } catch {}
          if (mySession != 0 && pSession != 0 && pSession != mySession) continue;
          string exePath = "";
          try { exePath = p.MainModule != null ? (p.MainModule.FileName ?? "") : ""; } catch {}
          count++;
          stemCount++;
          if (stemPid == 0 || (string.IsNullOrEmpty(stemPath) && !string.IsNullOrEmpty(exePath))) {
            stemPid = p.Id;
            if (!string.IsNullOrEmpty(exePath)) stemPath = exePath;
          }
          if (bestPid == 0 || (string.IsNullOrEmpty(bestPath) && !string.IsNullOrEmpty(exePath))) {
            bestPid = p.Id;
            if (!string.IsNullOrEmpty(exePath)) bestPath = exePath;
          }
        } finally {
          try { p.Dispose(); } catch {}
        }
      }
      if (stemCount > 0) {
        string key = (stem + ".exe").ToLowerInvariant();
        byExeJson.Add(
          "\"" + JsonEscape(key) + "\":{\"pid\":" + stemPid.ToString(CultureInfo.InvariantCulture)
          + ",\"count\":" + stemCount.ToString(CultureInfo.InvariantCulture)
          + ",\"exePath\":\"" + JsonEscape(stemPath) + "\"}"
        );
      }
    }
    Console.Out.WriteLine(
      "{\"ok\":true,\"running\":" + (count > 0 ? "true" : "false")
      + ",\"count\":" + count.ToString(CultureInfo.InvariantCulture)
      + ",\"pid\":" + bestPid.ToString(CultureInfo.InvariantCulture)
      + ",\"exePath\":\"" + JsonEscape(bestPath) + "\""
      + ",\"byExe\":{" + string.Join(",", byExeJson.ToArray()) + "}}"
    );
    return 0;
  }

  private sealed class TrayIconItem {
    public string Surface;
    public string Name;
    public string AutomationId;
    public string ClassName;
    public int X;
    public int Y;
    public int Width;
    public int Height;
  }

  private static bool TryInvokeElement(AutomationElement el) {
    if (el == null) return false;
    object patObj = null;
    try {
      if (el.TryGetCurrentPattern(InvokePattern.Pattern, out patObj)) {
        var inv = patObj as InvokePattern;
        if (inv != null) {
          inv.Invoke();
          return true;
        }
      }
    } catch {}
    try {
      if (el.TryGetCurrentPattern(TogglePattern.Pattern, out patObj)) {
        var tog = patObj as TogglePattern;
        if (tog != null) {
          tog.Toggle();
          return true;
        }
      }
    } catch {}
    return false;
  }

  private static bool IsChevronButton(string aid, string name) {
    if (!string.IsNullOrEmpty(aid)) {
      if (string.Equals(aid, "SystemTrayIcon", StringComparison.OrdinalIgnoreCase)
        || string.Equals(aid, "1502", StringComparison.OrdinalIgnoreCase)
        || aid.IndexOf("ShowHiddenIcons", StringComparison.OrdinalIgnoreCase) >= 0
        || aid.IndexOf("NotifyIconChevron", StringComparison.OrdinalIgnoreCase) >= 0
        || aid.IndexOf("Chevron", StringComparison.OrdinalIgnoreCase) >= 0) {
        return true;
      }
    }
    if (!string.IsNullOrEmpty(name)) {
      if (name.IndexOf("隐藏的图标", StringComparison.OrdinalIgnoreCase) >= 0
        || name.IndexOf("Hidden icons", StringComparison.OrdinalIgnoreCase) >= 0
        || name.IndexOf("Show Hidden Icons", StringComparison.OrdinalIgnoreCase) >= 0
        || name.IndexOf("Notification Chevron", StringComparison.OrdinalIgnoreCase) >= 0
        || name.IndexOf("系统托盘溢出", StringComparison.OrdinalIgnoreCase) >= 0) {
        return true;
      }
    }
    return false;
  }

  private static AutomationElement FindOverflowWindowElement() {
    try {
      var cond = new OrCondition(
        new PropertyCondition(AutomationElement.ClassNameProperty, "TopLevelWindowForOverflowXamlIsland"),
        new PropertyCondition(AutomationElement.ClassNameProperty, "NotifyIconOverflowWindow")
      );
      var matches = AutomationElement.RootElement.FindAll(TreeScope.Children, cond);
      if (matches != null) {
        foreach (AutomationElement el in matches) {
          try {
            IntPtr hw = new IntPtr(el.Current.NativeWindowHandle);
            if (hw != IntPtr.Zero && (!IsWindowVisible(hw) || IsWindowCloaked(hw))) continue;
            var b = el.Current.BoundingRectangle;
            if (!b.IsEmpty && b.Width > 10 && b.Height > 10 && !el.Current.IsOffscreen) {
              return el;
            }
          } catch {}
        }
      }
    } catch {}
    foreach (string cls in new[] { "TopLevelWindowForOverflowXamlIsland", "NotifyIconOverflowWindow" }) {
      try {
        IntPtr hw = FindWindowW(cls, null);
        if (hw != IntPtr.Zero && IsWindowVisible(hw) && !IsWindowCloaked(hw)) {
          RECT r;
          if (GetWindowRect(hw, out r) && (r.Right - r.Left) > 10 && (r.Bottom - r.Top) > 10) {
            return AutomationElement.FromHandle(hw);
          }
        }
      } catch {}
    }
    return null;
  }

  private static void CollectTrayState(
    bool openOverflow,
    bool closeAfter,
    out List<TrayIconItem> items,
    out bool overflowVisible,
    out bool overflowWasOpened,
    out bool chevronFound,
    out int chevCx,
    out int chevCy
  ) {
    items = new List<TrayIconItem>();
    overflowVisible = false;
    overflowWasOpened = false;
    chevronFound = false;
    chevCx = 0;
    chevCy = 0;

    IntPtr shellTray = FindWindowW("Shell_TrayWnd", null);
    AutomationElement chevronEl = null;
    double chevronLeftX = double.MaxValue;

    if (shellTray != IntPtr.Zero) {
      try {
        var trayEl = AutomationElement.FromHandle(shellTray);
        var btnCond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button);
        var btns = trayEl.FindAll(TreeScope.Descendants, btnCond);
        var trayRaw = new List<TrayIconItem>();
        int minTrayX = int.MaxValue;
        RECT trayRect;
        int trayW = 1920;
        if (GetWindowRect(shellTray, out trayRect)) {
          trayW = Math.Max(400, trayRect.Right - trayRect.Left);
          minTrayX = trayRect.Left + (int)(trayW * 0.45);
        }

        if (btns != null) {
          foreach (AutomationElement btn in btns) {
            try {
              var cur = btn.Current;
              var b = cur.BoundingRectangle;
              if (b.IsEmpty || b.Width < 8 || b.Height < 8 || cur.IsOffscreen) continue;
              string aid = cur.AutomationId ?? "";
              string name = (cur.Name ?? "").Trim();
              string cls = cur.ClassName ?? "";
              if (IsChevronButton(aid, name)) {
                if (chevronEl == null) {
                  chevronEl = btn;
                  chevronFound = true;
                  chevronLeftX = b.X;
                  chevCx = (int)Math.Round(b.X + b.Width / 2.0);
                  chevCy = (int)Math.Round(b.Y + b.Height / 2.0);
                }
                continue;
              }
              if (string.IsNullOrEmpty(name)) continue;
              bool isAppPinnedOrTaskbar = aid.StartsWith("Appid:", StringComparison.OrdinalIgnoreCase)
                || aid.StartsWith("StartButton", StringComparison.OrdinalIgnoreCase)
                || aid.StartsWith("SearchButton", StringComparison.OrdinalIgnoreCase)
                || aid.StartsWith("TaskViewButton", StringComparison.OrdinalIgnoreCase)
                || aid.StartsWith("WidgetsButton", StringComparison.OrdinalIgnoreCase);
              if (isAppPinnedOrTaskbar) continue;
              bool looksTrayClass = cls.IndexOf("SystemTray", StringComparison.OrdinalIgnoreCase) >= 0
                || cls.IndexOf("Toolbar", StringComparison.OrdinalIgnoreCase) >= 0
                || aid.IndexOf("Notify", StringComparison.OrdinalIgnoreCase) >= 0;
              bool inTrayZone = chevronLeftX < double.MaxValue
                ? (b.X >= chevronLeftX - 40)
                : (b.X >= minTrayX && b.Width <= 80);
              if (!looksTrayClass && !inTrayZone) continue;
              trayRaw.Add(new TrayIconItem {
                Surface = "promoted",
                Name = name,
                AutomationId = aid,
                ClassName = cls,
                X = (int)Math.Round(b.X),
                Y = (int)Math.Round(b.Y),
                Width = (int)Math.Round(b.Width),
                Height = (int)Math.Round(b.Height),
              });
            } catch {}
          }
        }
        items.AddRange(trayRaw);
      } catch {}
    }

    AutomationElement overflowEl = FindOverflowWindowElement();
    if (overflowEl == null && openOverflow && chevronEl != null) {
      bool invoked = TryInvokeElement(chevronEl);
      if (invoked) {
        overflowWasOpened = true;
        var waitSw = Stopwatch.StartNew();
        while (waitSw.ElapsedMilliseconds < 450) {
          Thread.Sleep(35);
          overflowEl = FindOverflowWindowElement();
          if (overflowEl != null) {
            Thread.Sleep(110);
            break;
          }
        }
      }
      if (overflowEl == null && chevCx > 0 && chevCy > 0) {
        POINT savedCh;
        GetCursorPos(out savedCh);
        PerformClickAt(chevCx, chevCy, "left", 1, 12);
        SetCursorPos(savedCh.X, savedCh.Y);
        overflowWasOpened = true;
        var waitSw2 = Stopwatch.StartNew();
        while (waitSw2.ElapsedMilliseconds < 500) {
          Thread.Sleep(35);
          overflowEl = FindOverflowWindowElement();
          if (overflowEl != null) {
            Thread.Sleep(110);
            break;
          }
        }
      }
    }

    if (overflowEl != null) {
      overflowVisible = true;
      try {
        var btnCond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button);
        var ovBtns = overflowEl.FindAll(TreeScope.Descendants, btnCond);
        if (ovBtns != null) {
          foreach (AutomationElement btn in ovBtns) {
            try {
              var cur = btn.Current;
              var b = cur.BoundingRectangle;
              if (b.IsEmpty || b.Width < 8 || b.Height < 8 || cur.IsOffscreen) continue;
              string name = (cur.Name ?? "").Trim();
              string aid = cur.AutomationId ?? "";
              if (string.IsNullOrEmpty(name)) continue;
              items.Add(new TrayIconItem {
                Surface = "overflow",
                Name = name,
                AutomationId = aid,
                ClassName = cur.ClassName ?? "",
                X = (int)Math.Round(b.X),
                Y = (int)Math.Round(b.Y),
                Width = (int)Math.Round(b.Width),
                Height = (int)Math.Round(b.Height),
              });
            } catch {}
          }
        }
      } catch {}

      if (closeAfter && overflowWasOpened && chevronEl != null) {
        TryInvokeElement(chevronEl);
        Thread.Sleep(60);
      }
    }
  }

  private static string SerializeTrayItems(List<TrayIconItem> items) {
    var list = new List<string>();
    foreach (var it in items) {
      int cx = it.X + it.Width / 2;
      int cy = it.Y + it.Height / 2;
      list.Add(
        "{\"surface\":\"" + JsonEscape(it.Surface) + "\""
        + ",\"name\":\"" + JsonEscape(it.Name) + "\""
        + ",\"automationId\":\"" + JsonEscape(it.AutomationId) + "\""
        + ",\"bounds\":{\"x\":" + it.X + ",\"y\":" + it.Y + ",\"width\":" + it.Width + ",\"height\":" + it.Height + "}"
        + ",\"center\":{\"x\":" + cx + ",\"y\":" + cy + "}}"
      );
    }
    return "[" + string.Join(",", list.ToArray()) + "]";
  }

  private static int RunTrayList(int openOverflow, int closeAfter) {
    string desktopName;
    bool isDefault = IsInteractiveDefaultDesktop(out desktopName);
    if (!isDefault) {
      Console.Out.WriteLine("{\"ok\":true,\"isInteractiveDefaultDesktop\":false,\"chevronFound\":false,\"overflowVisible\":false,\"icons\":[]}");
      return 0;
    }
    List<TrayIconItem> items;
    bool overflowVisible, overflowOpened, chevronFound;
    int chevCx, chevCy;
    CollectTrayState(openOverflow != 0, closeAfter != 0, out items, out overflowVisible, out overflowOpened, out chevronFound, out chevCx, out chevCy);
    Console.Out.WriteLine(
      "{\"ok\":true,\"isInteractiveDefaultDesktop\":true"
      + ",\"chevronFound\":" + (chevronFound ? "true" : "false")
      + ",\"chevronCenter\":{\"x\":" + chevCx + ",\"y\":" + chevCy + "}"
      + ",\"overflowVisible\":" + (overflowVisible ? "true" : "false")
      + ",\"overflowOpened\":" + (overflowOpened ? "true" : "false")
      + ",\"count\":" + items.Count.ToString(CultureInfo.InvariantCulture)
      + ",\"icons\":" + SerializeTrayItems(items) + "}"
    );
    return 0;
  }

  private static bool MatchesTrayKeywords(string name, string[] includes, string[] excludes) {
    if (string.IsNullOrEmpty(name)) return false;
    foreach (string ex in excludes) {
      if (!string.IsNullOrEmpty(ex) && name.IndexOf(ex, StringComparison.OrdinalIgnoreCase) >= 0) return false;
    }
    foreach (string inc in includes) {
      if (!string.IsNullOrEmpty(inc) && name.IndexOf(inc, StringComparison.OrdinalIgnoreCase) >= 0) return true;
    }
    return false;
  }

  private static int RunTrayActivate(string includeCsv, string excludeCsv, int doubleClick) {
    string desktopName;
    if (!IsInteractiveDefaultDesktop(out desktopName)) {
      Console.Out.WriteLine("{\"ok\":false,\"code\":\"DESKTOP_SANDBOX_ISOLATED\",\"message\":\"Tray activation requires WinSta0\\\\Default\"}");
      return 1;
    }
    var incList = new List<string>();
    foreach (string s in (includeCsv ?? "").Split(',')) {
      string t = s.Trim();
      if (t.Length > 0) incList.Add(t);
    }
    var excList = new List<string>();
    foreach (string s in (excludeCsv ?? "").Split(',')) {
      string t = s.Trim();
      if (t.Length > 0 && t != "-") excList.Add(t);
    }
    string[] includes = incList.ToArray();
    string[] excludes = excList.ToArray();

    List<TrayIconItem> items;
    bool overflowVisible, overflowOpened, chevronFound;
    int chevCx, chevCy;
    // First probe promoted tray without opening overflow
    CollectTrayState(false, false, out items, out overflowVisible, out overflowOpened, out chevronFound, out chevCx, out chevCy);
    TrayIconItem hit = null;
    foreach (var it in items) {
      if (MatchesTrayKeywords(it.Name, includes, excludes)) { hit = it; break; }
    }
    if (hit == null) {
      // Open Windows 11/10 hidden tray overflow ("后台任务 / 显示隐藏的图标") and keep open briefly for click
      CollectTrayState(true, false, out items, out overflowVisible, out overflowOpened, out chevronFound, out chevCx, out chevCy);
      foreach (var it in items) {
        if (MatchesTrayKeywords(it.Name, includes, excludes)) { hit = it; break; }
      }
      if (hit == null && overflowOpened) {
        IntPtr shellTray = FindWindowW("Shell_TrayWnd", null);
        if (shellTray != IntPtr.Zero) {
          try {
            var trayEl = AutomationElement.FromHandle(shellTray);
            var btns = trayEl.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button));
            if (btns != null) {
              foreach (AutomationElement btn in btns) {
                var cur = btn.Current;
                if (IsChevronButton(cur.AutomationId ?? "", (cur.Name ?? "").Trim())) {
                  TryInvokeElement(btn);
                  break;
                }
              }
            }
          } catch {}
        }
      }
    }

    if (hit == null) {
      Console.Out.WriteLine(
        "{\"ok\":true,\"found\":false,\"chevronFound\":" + (chevronFound ? "true" : "false")
        + ",\"overflowVisible\":" + (overflowVisible ? "true" : "false")
        + ",\"scannedCount\":" + items.Count.ToString(CultureInfo.InvariantCulture) + "}"
      );
      return 0;
    }

    int cx = hit.X + hit.Width / 2;
    int cy = hit.Y + hit.Height / 2;
    POINT saved;
    GetCursorPos(out saved);
    PerformClickAt(cx, cy, "left", doubleClick != 0 ? 2 : 1, 14);
    SetCursorPos(saved.X, saved.Y);

    Console.Out.WriteLine(
      "{\"ok\":true,\"found\":true,\"surface\":\"" + JsonEscape(hit.Surface) + "\""
      + ",\"name\":\"" + JsonEscape(hit.Name) + "\""
      + ",\"doubleClick\":" + (doubleClick != 0 ? "true" : "false")
      + ",\"clicked\":{\"x\":" + cx + ",\"y\":" + cy + "}}"
    );
    return 0;
  }

  public static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    try { SetProcessDPIAware(); } catch {}
    if (args.Length == 0) {
      Console.Out.WriteLine("{\"ok\":false,\"code\":\"INVALID_ARGS\",\"message\":\"Subcommand required\"}");
      return 1;
    }
    try {
      string sub = args[0];
      if (sub == "env") return RunEnv();
      if (sub == "focus") {
        if (args.Length < 2) throw new ArgumentException("focus requires <windowId>");
        string pidArg = args.Length >= 3 ? args[2] : "0";
        return RunFocus(args[1], pidArg);
      }
      if (sub == "shell-launch") {
        if (args.Length < 2) throw new ArgumentException("shell-launch requires <exePath>");
        string cwd = args.Length >= 3 ? args[2] : "";
        string[] extra = new string[Math.Max(0, args.Length - 3)];
        for (int i = 3; i < args.Length; i++) extra[i - 3] = args[i];
        return RunShellLaunch(args[1], cwd, extra);
      }
      if (sub == "ripple") {
        if (args.Length < 3) throw new ArgumentException("ripple requires <x> <y>");
        int x = int.Parse(args[1], CultureInfo.InvariantCulture);
        int y = int.Parse(args[2], CultureInfo.InvariantCulture);
        int dur = args.Length >= 4 ? int.Parse(args[3], CultureInfo.InvariantCulture) : 320;
        string color = args.Length >= 5 ? args[4] : "0EA5E9";
        return RunRipple(x, y, dur, color);
      }
      if (sub == "cursor-prep") {
        int guard = args.Length >= 2 ? int.Parse(args[1], CultureInfo.InvariantCulture) : 500;
        return RunCursorPrep(guard);
      }
      if (sub == "cursor-restore") {
        if (args.Length < 3) throw new ArgumentException("cursor-restore requires <x> <y>");
        int x = int.Parse(args[1], CultureInfo.InvariantCulture);
        int y = int.Parse(args[2], CultureInfo.InvariantCulture);
        int settle = args.Length >= 4 ? int.Parse(args[3], CultureInfo.InvariantCulture) : 18;
        return RunCursorRestore(x, y, settle);
      }
      if (sub == "post-click") {
        if (args.Length < 4) throw new ArgumentException("post-click requires <windowId> <x> <y>");
        int x = int.Parse(args[2], CultureInfo.InvariantCulture);
        int y = int.Parse(args[3], CultureInfo.InvariantCulture);
        string btn = args.Length >= 5 ? args[4] : "left";
        int cnt = args.Length >= 6 ? int.Parse(args[5], CultureInfo.InvariantCulture) : 1;
        return RunPostClick(args[1], x, y, btn, cnt);
      }
      if (sub == "click-restore") {
        if (args.Length < 3) throw new ArgumentException("click-restore requires <x> <y>");
        int x = int.Parse(args[1], CultureInfo.InvariantCulture);
        int y = int.Parse(args[2], CultureInfo.InvariantCulture);
        string btn = args.Length >= 4 ? args[3] : "left";
        int cnt = args.Length >= 5 ? int.Parse(args[4], CultureInfo.InvariantCulture) : 1;
        int restore = args.Length >= 6 ? int.Parse(args[5], CultureInfo.InvariantCulture) : 1;
        int guard = args.Length >= 7 ? int.Parse(args[6], CultureInfo.InvariantCulture) : 120;
        int settle = args.Length >= 8 ? int.Parse(args[7], CultureInfo.InvariantCulture) : 14;
        return RunClickAndRestore(x, y, btn, cnt, restore, guard, settle);
      }
      if (sub == "find-proc") {
        if (args.Length < 2) throw new ArgumentException("find-proc requires <namesCsv>");
        return RunFindProc(args[1]);
      }
      if (sub == "tray-list") {
        int openOv = args.Length >= 2 ? int.Parse(args[1], CultureInfo.InvariantCulture) : 0;
        int closeOv = args.Length >= 3 ? int.Parse(args[2], CultureInfo.InvariantCulture) : 1;
        return RunTrayList(openOv, closeOv);
      }
      if (sub == "tray-activate") {
        if (args.Length < 2) throw new ArgumentException("tray-activate requires <includeCsv>");
        string excCsv = args.Length >= 3 ? args[2] : "-";
        int dbl = args.Length >= 4 ? int.Parse(args[3], CultureInfo.InvariantCulture) : 0;
        return RunTrayActivate(args[1], excCsv, dbl);
      }
      if (sub == "to-png") {
        if (args.Length < 3) throw new ArgumentException("to-png requires <src> <dst>");
        return RunToPng(args[1], args[2]);
      }
      if (sub == "region-hash") {
        if (args.Length < 2) throw new ArgumentException("region-hash requires <imagePath>");
        string crop = args.Length >= 3 ? args[2] : "-";
        return RunRegionHash(args[1], crop);
      }
      if (sub == "chat-layout") {
        if (args.Length < 2) throw new ArgumentException("chat-layout requires <imagePath>");
        return RunChatLayout(args[1]);
      }
      if (sub == "ocr") {
        if (args.Length < 2) throw new ArgumentException("ocr requires <imagePath>");
        string imgPath = args[1];
        string lang = args.Length >= 3 ? args[2] : "auto";
        string crop = args.Length >= 4 ? args[3] : "-";
        int scale = args.Length >= 5 ? int.Parse(args[4], CultureInfo.InvariantCulture) : 2;
        return RunOcr(imgPath, lang, crop, scale);
      }
      Console.Out.WriteLine("{\"ok\":false,\"code\":\"INVALID_ARGS\",\"message\":\"Unknown helper subcommand\"}");
      return 1;
    } catch (Exception ex) {
      Console.Out.WriteLine("{\"ok\":false,\"code\":\"WIN_HELPER_FAILED\",\"message\":\"" + JsonEscape(ex.Message) + "\"}");
      return 1;
    }
  }
}
`;

const CJK_CHAR_RE = /([\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef])\s+(?=[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef])/g;

const OCR_RADICAL_FOLDS = [
  ['亻制专', '件传'],
  ['文制专', '文件传'],
  ['且力', '助'],
  ['亻牛', '件'],
  ['亻专', '传'],
  ['亻尔', '你'],
  ['亻门', '们'],
  ['亻立', '位'],
  ['亻生', '住'],
  ['亻言', '信'],
  ['亻付', '付'],
  ['亻体', '体'],
  ['亻作', '作'],
  ['亻保', '保'],
  ['亻代', '代'],
  ['讠殳', '设'],
  ['讠十', '计'],
  ['讠兑', '说'],
  ['讠青', '请'],
  ['氵工', '江'],
  ['氵每', '海'],
  ['氵清', '清'],
  ['氵测', '测'],
  ['扌丁', '打'],
  ['扌立', '拉'],
  ['纟合', '给'],
  ['纟发', '发'],
];

function foldOcrCjkRadicals(text) {
  let out = String(text || '');
  for (const [splitSeq, merged] of OCR_RADICAL_FOLDS) {
    if (out.includes(splitSeq)) {
      out = out.split(splitSeq).join(merged);
    }
  }
  return out;
}

function normalizeOcrText(raw) {
  if (typeof raw !== 'string') return '';
  let prev = raw.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = prev.replace(CJK_CHAR_RE, '$1');
    if (next === prev) break;
    prev = next;
  }
  return prev.replace(/\s+/g, ' ').trim();
}

function compactSearchKey(raw) {
  return normalizeOcrText(raw).replace(/\s+/g, '').toLowerCase();
}

function canonicalOcrKey(raw) {
  return foldOcrCjkRadicals(compactSearchKey(raw));
}

function runtimeDir(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), '.agent-browser-bridge');
  return path.join(base, 'AgentBrowserBridge', 'runtime', HELPER_VERSION);
}

function findCscCompiler() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const csc of candidates) {
    if (fs.existsSync(csc)) return csc;
  }
  return null;
}

let cachedHelperExe = null;

function ensureWinHelperCompiled(env = process.env) {
  if (process.platform !== 'win32') {
    throw desktopError('UNSUPPORTED_PLATFORM', 'Windows native OCR/desktop helper is only available on win32');
  }
  if (cachedHelperExe && fs.existsSync(cachedHelperExe)) return cachedHelperExe;

  const hash = crypto.createHash('sha256').update(CSHARP_SOURCE).digest('hex').slice(0, 12);
  const dir = runtimeDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const targetExe = path.join(dir, `abb-win-helper-${hash}.exe`);
  if (fs.existsSync(targetExe)) {
    cachedHelperExe = targetExe;
    return targetExe;
  }

  const csc = findCscCompiler();
  if (!csc) {
    throw desktopError('WIN_HELPER_COMPILER_MISSING', 'Microsoft .NET Framework v4.0 csc.exe was not found');
  }
  const fwDir = path.dirname(csc);
  const windir = process.env.WINDIR || 'C:\\Windows';
  const winmdDir = path.join(windir, 'System32', 'WinMetadata');

  const facadeDlls = [
    'System.Runtime.dll',
    'System.Runtime.InteropServices.WindowsRuntime.dll',
    'System.Threading.Tasks.dll',
    'System.IO.dll',
    'System.ObjectModel.dll',
    'System.Collections.dll',
    'System.Globalization.dll',
  ].map(name => {
    const direct = path.join(fwDir, name);
    if (fs.existsSync(direct)) return direct;
    const sub = path.join(fwDir, 'Facades', name);
    return fs.existsSync(sub) ? sub : null;
  }).filter(Boolean);

  const wpfRefs = [
    'UIAutomationClient.dll',
    'UIAutomationTypes.dll',
    'WindowsBase.dll',
  ].map(name => path.join(fwDir, 'WPF', name)).filter(p => fs.existsSync(p));

  const refs = [
    'System.Drawing.dll',
    ...wpfRefs,
    path.join(fwDir, 'System.Runtime.WindowsRuntime.dll'),
    ...facadeDlls,
    path.join(winmdDir, 'Windows.Foundation.winmd'),
    path.join(winmdDir, 'Windows.Storage.winmd'),
    path.join(winmdDir, 'Windows.Graphics.winmd'),
    path.join(winmdDir, 'Windows.Media.winmd'),
    path.join(winmdDir, 'Windows.Globalization.winmd'),
  ].filter(ref => !path.isAbsolute(ref) || fs.existsSync(ref));

  const uniqueSuffix = `${process.pid}-${Date.now()}`;
  const tempCs = path.join(dir, `abb-win-helper-${hash}-${uniqueSuffix}.cs`);
  const tempExe = path.join(dir, `abb-win-helper-${hash}-${uniqueSuffix}.exe`);
  fs.writeFileSync(tempCs, CSHARP_SOURCE, 'utf8');
  try {
    const cscArgs = [
      '/nologo',
      '/optimize+',
      '/target:exe',
      `/out:${tempExe}`,
      ...refs.map(r => `/r:${r}`),
      tempCs,
    ];
    execFileSync(csc, cscArgs, {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      fs.renameSync(tempExe, targetExe);
    } catch (renameErr) {
      if (!fs.existsSync(targetExe)) throw renameErr;
    }
    cachedHelperExe = targetExe;
    return targetExe;
  } catch (err) {
    const detail = String(err.stdout || err.stderr || err.message || '').trim().slice(0, 500);
    throw desktopError('WIN_HELPER_COMPILE_FAILED', `Failed to compile native Windows helper: ${detail}`);
  } finally {
    try { fs.unlinkSync(tempCs); } catch {}
    try { if (fs.existsSync(tempExe)) fs.unlinkSync(tempExe); } catch {}
  }
}

function runWinHelper(args, options = {}) {
  const exe = ensureWinHelperCompiled(options.env);
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000;
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        signal: options.signal,
      },
      (error, stdout) => {
        const trimmed = String(stdout || '').trim();
        let parsed = null;
        if (trimmed) {
          const lines = trimmed.split(/\r?\n/);
          try { parsed = JSON.parse(lines[lines.length - 1]); } catch {}
        }
        const mutating = (parsed && typeof parsed.dispatched === 'boolean')
          ? parsed.dispatched
          : Boolean(options.mutating);
        if (parsed && parsed.ok === true) {
          resolve(parsed);
          return;
        }
        if (parsed && parsed.ok === false) {
          reject(desktopError(parsed.code || 'WIN_HELPER_FAILED', parsed.message || 'Windows helper failed', mutating));
          return;
        }
        if (error) {
          if (error.name === 'AbortError' || options.signal?.aborted) {
            reject(desktopError('ABORTED', 'Windows helper call was aborted', mutating));
            return;
          }
          reject(desktopError('WIN_HELPER_FAILED', error.message || 'Windows helper process failed', mutating));
          return;
        }
        reject(desktopError('WIN_HELPER_PROTOCOL_ERROR', 'Windows helper returned invalid JSON', mutating));
      },
    );
  });
}

function resolveRegionCrop(region, imgW, imgH) {
  if (!region || region === 'full' || region === 'all') return null;
  if (typeof region === 'object' && !Array.isArray(region)) {
    const { x, y, width, height } = region;
    if ([x, y, width, height].every(Number.isFinite)) {
      return {
        x: Math.max(0, Math.round(x)),
        y: Math.max(0, Math.round(y)),
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
      };
    }
  }
  const spec = String(region).trim().toLowerCase();
  if (spec === 'header') {
    return {
      x: Math.round(imgW * 0.28),
      y: 0,
      width: Math.max(1, Math.round(imgW * 0.72)),
      height: Math.max(48, Math.min(140, Math.round(imgH * 0.16))),
    };
  }
  if (spec === 'sidebar') {
    return {
      x: 0,
      y: 0,
      width: Math.max(80, Math.round(imgW * 0.34)),
      height: imgH,
    };
  }
  if (spec === 'messages') {
    return {
      x: Math.round(imgW * 0.28),
      y: Math.round(imgH * 0.10),
      width: Math.max(80, Math.round(imgW * 0.72)),
      height: Math.max(80, Math.round(imgH * 0.66)),
    };
  }
  if (spec === 'composer') {
    return {
      x: Math.round(imgW * 0.28),
      y: Math.round(imgH * 0.68),
      width: Math.max(80, Math.round(imgW * 0.72)),
      height: Math.max(60, Math.round(imgH * 0.32)),
    };
  }
  if (/^\d+(?:\.\d+)?,\d+(?:\.\d+)?,\d+(?:\.\d+)?,\d+(?:\.\d+)?$/.test(spec)) {
    const nums = spec.split(',').map(Number);
    if (nums.every(n => n >= 0 && n <= 1) && (nums[2] <= 1 && nums[3] <= 1) && spec.includes('.')) {
      return {
        x: Math.round(imgW * nums[0]),
        y: Math.round(imgH * nums[1]),
        width: Math.max(1, Math.round(imgW * nums[2])),
        height: Math.max(1, Math.round(imgH * nums[3])),
      };
    }
    return {
      x: Math.round(nums[0]),
      y: Math.round(nums[1]),
      width: Math.max(1, Math.round(nums[2])),
      height: Math.max(1, Math.round(nums[3])),
    };
  }
  throw desktopError('INVALID_ARGS', `Unsupported OCR region "${region}" (use full|header|sidebar|messages|composer|x,y,w,h)`);
}

function mapRectToScreen(rect, imageWidth, imageHeight, bounds) {
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || imageWidth <= 0 || imageHeight <= 0) {
    const cx = Math.round(rect.x + rect.width / 2);
    const cy = Math.round(rect.y + rect.height / 2);
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      center: { x: cx, y: cy },
    };
  }
  const scaleX = bounds.width / imageWidth;
  const scaleY = bounds.height / imageHeight;
  const sx = bounds.x + rect.x * scaleX;
  const sy = bounds.y + rect.y * scaleY;
  const sw = rect.width * scaleX;
  const sh = rect.height * scaleY;
  return {
    x: Math.round(sx),
    y: Math.round(sy),
    width: Math.max(1, Math.round(sw)),
    height: Math.max(1, Math.round(sh)),
    center: {
      x: Math.round(sx + sw / 2),
      y: Math.round(sy + sh / 2),
    },
  };
}

function unionWordRect(words) {
  let minX = Infinity;
  let minY = Infinity;
  let maxR = -Infinity;
  let maxB = -Infinity;
  for (const w of words) {
    if (w.x < minX) minX = w.x;
    if (w.y < minY) minY = w.y;
    if (w.x + w.width > maxR) maxR = w.x + w.width;
    if (w.y + w.height > maxB) maxB = w.y + w.height;
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxR - minX),
    height: Math.max(1, maxB - minY),
  };
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

function allowedOcrEditDistance(needleCompact, strictExact = false) {
  if (strictExact) return 0;
  const len = needleCompact.length;
  if (len <= 3) return 0;
  if (len <= 8) return 1;
  return Math.floor(len * 0.15);
}

function findTightWordSpan(line, needleCompact, maxDist = 0, needleCanon = canonicalOcrKey(needleCompact)) {
  const words = Array.isArray(line.words) ? line.words : [];
  if (!words.length || !needleCompact) return null;
  let best = null;
  for (let start = 0; start < words.length; start += 1) {
    let acc = '';
    for (let end = start; end < words.length; end += 1) {
      acc += compactSearchKey(words[end].text);
      if (!acc) continue;
      if (acc.includes(needleCompact)) {
        const spanLen = acc.length;
        if (!best || best.distance > 0 || best.radicalFolded || spanLen < best.spanLen) {
          const subWords = words.slice(start, end + 1);
          best = {
            distance: 0,
            spanLen,
            radicalFolded: false,
            matchedText: normalizeOcrText(subWords.map(w => w.text).join(' ')),
            imageRect: unionWordRect(subWords),
          };
        }
        break;
      }
      const accCanon = foldOcrCjkRadicals(acc);
      if (needleCanon && accCanon.includes(needleCanon)) {
        const spanLen = accCanon.length;
        if (!best || best.distance > 0 || (best.radicalFolded && spanLen < best.spanLen)) {
          const subWords = words.slice(start, end + 1);
          best = {
            distance: 0,
            spanLen,
            radicalFolded: true,
            matchedText: normalizeOcrText(subWords.map(w => w.text).join(' ')),
            imageRect: unionWordRect(subWords),
          };
        }
        break;
      }
      const candKey = needleCanon ? accCanon : acc;
      const targetKey = needleCanon || needleCompact;
      if (maxDist > 0 && Math.abs(candKey.length - targetKey.length) <= maxDist) {
        const dist = levenshteinDistance(candKey, targetKey);
        if (dist <= maxDist) {
          const spanLen = candKey.length;
          if (!best || dist < best.distance || (dist === best.distance && Math.abs(spanLen - targetKey.length) < Math.abs(best.spanLen - targetKey.length))) {
            const subWords = words.slice(start, end + 1);
            best = {
              distance: dist,
              spanLen,
              radicalFolded: accCanon !== acc,
              matchedText: normalizeOcrText(subWords.map(w => w.text).join(' ')),
              imageRect: unionWordRect(subWords),
            };
          }
        }
      }
    }
  }
  return best;
}

function findOcrMatches(ocrData, query, bounds = null, options = {}) {
  const needle = compactSearchKey(query);
  if (!needle) return [];
  const needleCanon = canonicalOcrKey(query);
  const strictExact = Boolean(options.strictExact);
  const maxDist = allowedOcrEditDistance(needleCanon || needle, strictExact);
  const matches = [];
  const lines = Array.isArray(ocrData?.lines) ? ocrData.lines : [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const lineCompact = compactSearchKey(line.text || line.rawText || '');
    if (!lineCompact) continue;
    const lineCanon = foldOcrCjkRadicals(lineCompact);
    const directHit = lineCompact.includes(needle);
    const foldedDirectHit = !strictExact && !directHit && needleCanon && lineCanon.includes(needleCanon);
    const tight = findTightWordSpan(line, needle, maxDist, strictExact ? '' : needleCanon);
    let distance = (directHit || foldedDirectHit) ? 0 : (tight ? tight.distance : Infinity);
    if (!directHit && !foldedDirectHit && distance > maxDist && maxDist > 0) {
      const cmpLine = strictExact ? lineCompact : lineCanon;
      const cmpNeedle = strictExact ? needle : needleCanon;
      if (Math.abs(cmpLine.length - cmpNeedle.length) <= maxDist) {
        const lineDist = levenshteinDistance(cmpLine, cmpNeedle);
        if (lineDist <= maxDist) distance = lineDist;
      }
    }
    if (distance > maxDist) continue;
    const exact = directHit && lineCompact === needle;
    const radicalFolded = Boolean(foldedDirectHit || tight?.radicalFolded);
    const confidence = distance === 0
      ? (radicalFolded && !directHit ? 'ocr_radical_folded' : 'exact')
      : 'ocr_fuzzy_1';
    const imgRect = tight ? tight.imageRect : { x: line.x, y: line.y, width: line.width, height: line.height };
    const screen = mapRectToScreen(imgRect, ocrData.imageWidth, ocrData.imageHeight, bounds);
    matches.push({
      lineIndex,
      lineText: line.text,
      matchedText: tight ? tight.matchedText : line.text,
      exact,
      distance,
      confidence,
      imageRect: imgRect,
      screen,
    });
  }
  matches.sort((a, b) => (a.distance - b.distance) || (Number(b.exact) - Number(a.exact)) || (a.screen.y - b.screen.y) || (a.screen.x - b.screen.x));
  return matches;
}

function readPngDimensionsFast(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(24);
    const bytes = fs.readSync(fd, header, 0, 24, 0);
    if (bytes < 24) return null;
    if (header[0] !== 0x89 || header[1] !== 0x50 || header[2] !== 0x4e || header[3] !== 0x47) return null;
    return {
      width: header.readUInt32BE(16),
      height: header.readUInt32BE(20),
    };
  } finally {
    fs.closeSync(fd);
  }
}

async function ocrImage(imagePath, options = {}) {
  const absPath = path.resolve(imagePath);
  if (!fs.existsSync(absPath)) {
    throw desktopError('INVALID_ARGS', 'OCR image file does not exist');
  }
  let cropArg = '-';
  if (options.region && options.region !== 'full' && options.region !== 'all') {
    const dims = readPngDimensionsFast(absPath);
    if (dims) {
      const crop = resolveRegionCrop(options.region, dims.width, dims.height);
      if (crop) cropArg = `${crop.x},${crop.y},${crop.width},${crop.height}`;
    } else if (typeof options.region === 'string' && /^\d+,\d+,\d+,\d+$/.test(options.region.trim())) {
      cropArg = options.region.trim();
    }
  }
  const lang = options.lang || 'auto';
  const scale = Number.isInteger(options.scale) && options.scale >= 1 && options.scale <= 4 ? options.scale : 2;
  const raw = await runWinHelper(['ocr', absPath, lang, cropArg, String(scale)], options);
  const bounds = options.bounds || null;
  const fullLines = (raw.lines || []).map(line => {
    const normalizedText = normalizeOcrText(line.rawText);
    const imgRect = { x: line.x, y: line.y, width: line.width, height: line.height };
    return {
      text: normalizedText,
      rawText: line.rawText,
      x: line.x,
      y: line.y,
      width: line.width,
      height: line.height,
      imageRect: imgRect,
      screen: mapRectToScreen(imgRect, raw.imageWidth, raw.imageHeight, bounds),
      words: line.words || [],
    };
  });
  const text = fullLines.map(l => l.text).filter(Boolean).join('\n');
  const matches = (typeof options.find === 'string' && options.find.trim())
    ? findOcrMatches({ imageWidth: raw.imageWidth, imageHeight: raw.imageHeight, lines: fullLines }, options.find, bounds)
    : undefined;

  const includeWords = options.includeWords !== false;
  let formattedLines = fullLines.map(l => (includeWords
    ? {
      text: l.text,
      rawText: l.rawText,
      x: l.x,
      y: l.y,
      width: l.width,
      height: l.height,
      imageRect: l.imageRect,
      screen: l.screen,
      words: l.words,
    }
    : {
      text: l.text,
      imageRect: l.imageRect,
      screen: l.screen,
    }));
  let truncatedLines = 0;
  if (Number.isInteger(options.maxLines) && options.maxLines > 0 && formattedLines.length > options.maxLines) {
    truncatedLines = formattedLines.length - options.maxLines;
    formattedLines = formattedLines.slice(0, options.maxLines);
  }

  const result = {
    language: raw.language,
    imageWidth: raw.imageWidth,
    imageHeight: raw.imageHeight,
    crop: raw.crop,
    scale: raw.scale,
    bounds,
    lineCount: fullLines.length,
    ...(truncatedLines > 0 ? { truncatedLines } : {}),
    text,
    ...(options.includeLines === false ? {} : { lines: formattedLines }),
    ...(matches !== undefined ? { matches } : {}),
  };
  return result;
}

async function inspectDesktopEnvironment(options = {}) {
  if (process.platform !== 'win32') {
    return {
      platform: process.platform,
      isInteractiveDefaultDesktop: true,
      ocrLanguages: [],
    };
  }
  return runWinHelper(['env'], options);
}

function isPngFileHeader(filePath) {
  return Boolean(readPngDimensionsFast(filePath));
}

async function ensurePngImageFile(srcPath, tempDir, options = {}) {
  const absSrc = path.resolve(srcPath);
  let stat;
  try {
    stat = fs.statSync(absSrc);
  } catch {
    throw desktopError('INVALID_ARGS', 'Image file does not exist on disk');
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw desktopError('INVALID_ARGS', 'Image path must be a non-empty regular file');
  }
  if (isPngFileHeader(absSrc)) {
    return { pngPath: absSrc, converted: false };
  }
  const outDir = tempDir || fs.mkdtempSync(path.join(os.tmpdir(), 'abb-img-png-'));
  fs.mkdirSync(outDir, { recursive: true });
  const outPng = path.join(outDir, `converted-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await runWinHelper(['to-png', absSrc, outPng], options);
  return { pngPath: outPng, converted: true };
}

async function assistForegroundWindow(windowId, pid = 0, options = {}) {
  if (process.platform !== 'win32') return { focused: false, isInteractiveDefaultDesktop: true };
  if (typeof windowId !== 'string' || !/^w-\d+$/.test(windowId)) {
    return { focused: false, isInteractiveDefaultDesktop: true };
  }
  return runWinHelper(['focus', windowId, String(pid || 0)], options);
}

async function launchDetachedViaShell(exePath, args = [], options = {}) {
  if (process.platform !== 'win32') {
    throw desktopError('UNSUPPORTED_PLATFORM', 'Shell detached launch is only available on win32');
  }
  if (typeof exePath !== 'string' || !exePath.trim()) {
    throw desktopError('INVALID_ARGS', 'launchDetachedViaShell requires a valid executable path');
  }
  const absExe = path.resolve(exePath.trim());
  let st;
  try {
    st = fs.statSync(absExe);
  } catch {
    throw desktopError('APP_EXECUTABLE_NOT_FOUND', 'Target executable path does not exist');
  }
  if (!st.isFile() || !/\.exe$/i.test(absExe)) {
    throw desktopError('INVALID_ARGS', 'launchDetachedViaShell requires a .exe regular file');
  }
  const cwd = options.cwd ? path.resolve(options.cwd) : path.dirname(absExe);
  const extra = Array.isArray(args) ? args.map(String) : [];
  return runWinHelper(['shell-launch', absExe, cwd, ...extra], options);
}

function spawnClickRipple(x, y, options = {}) {
  if (process.platform !== 'win32') return false;
  if (![x, y].every(Number.isFinite)) return false;
  let exe;
  try {
    exe = ensureWinHelperCompiled(options.env);
  } catch {
    return false;
  }
  const durationMs = Number.isFinite(options.durationMs)
    ? Math.max(80, Math.min(1200, Math.round(options.durationMs)))
    : 320;
  const colorHex = typeof options.color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(options.color.trim())
    ? options.color.trim().replace(/^#/, '')
    : '0EA5E9';
  try {
    const child = spawn(
      exe,
      ['ripple', String(Math.round(x)), String(Math.round(y)), String(durationMs), colorHex],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function prepareCoordinateCursor(options = {}) {
  if (process.platform !== 'win32') return { ok: true, skipped: true, x: 0, y: 0, humanYieldMs: 0 };
  const guardMs = Number.isFinite(options.humanGuardMs)
    ? Math.max(0, Math.min(3000, Math.round(options.humanGuardMs)))
    : 500;
  return runWinHelper(['cursor-prep', String(guardMs)], {
    ...options,
    timeoutMs: Math.max(options.timeoutMs || 5000, guardMs + 2000),
  });
}

async function restoreCursorPosition(x, y, settleMs = 18, options = {}) {
  if (process.platform !== 'win32') return { ok: true, skipped: true };
  if (![x, y].every(Number.isFinite)) {
    throw desktopError('INVALID_ARGS', 'restoreCursorPosition requires finite x and y coordinates');
  }
  const settle = Number.isFinite(settleMs) ? Math.max(0, Math.min(500, Math.round(settleMs))) : 18;
  return runWinHelper(
    ['cursor-restore', String(Math.round(x)), String(Math.round(y)), String(settle)],
    options,
  );
}

async function postMessageClick(windowId, x, y, options = {}) {
  if (process.platform !== 'win32') {
    throw desktopError('UNSUPPORTED_PLATFORM', 'postMessageClick is only available on win32');
  }
  if (typeof windowId !== 'string' || !/^w-\d+$/.test(windowId)) {
    throw desktopError('INVALID_ARGS', 'postMessageClick requires a valid w-<hwnd> windowId');
  }
  if (![x, y].every(Number.isFinite)) {
    throw desktopError('INVALID_ARGS', 'postMessageClick requires finite x and y coordinates');
  }
  const button = ['left', 'right', 'middle'].includes(options.button) ? options.button : 'left';
  const count = Number.isInteger(options.count) && options.count >= 1 && options.count <= 3 ? options.count : 1;
  return runWinHelper(
    ['post-click', windowId, String(Math.round(x)), String(Math.round(y)), button, String(count)],
    { ...options, mutating: true },
  );
}

async function clickAndRestore(x, y, options = {}) {
  if (process.platform !== 'win32') {
    throw desktopError('UNSUPPORTED_PLATFORM', 'clickAndRestore is only available on win32');
  }
  if (![x, y].every(Number.isFinite)) {
    throw desktopError('INVALID_ARGS', 'clickAndRestore requires finite x and y coordinates');
  }
  const button = ['left', 'right', 'middle'].includes(options.button) ? options.button : 'left';
  const count = Number.isInteger(options.count) && options.count >= 1 && options.count <= 3 ? options.count : 1;
  const restoreFlag = options.restoreCursor === false ? '0' : '1';
  const guardMs = Number.isFinite(options.humanGuardMs)
    ? Math.max(0, Math.min(3000, Math.round(options.humanGuardMs)))
    : 120;
  const settleMs = Number.isFinite(options.settleMs)
    ? Math.max(0, Math.min(500, Math.round(options.settleMs)))
    : 14;
  return runWinHelper(
    [
      'click-restore',
      String(Math.round(x)),
      String(Math.round(y)),
      button,
      String(count),
      restoreFlag,
      String(guardMs),
      String(settleMs),
    ],
    {
      ...options,
      mutating: true,
      timeoutMs: Math.max(options.timeoutMs || 6000, guardMs + settleMs + 2500),
    },
  );
}

async function queryRunningProcessInfo(exeNames, options = {}) {
  if (process.platform !== 'win32') return { ok: true, running: false, count: 0, pid: 0, exePath: '', byExe: {} };
  const list = Array.isArray(exeNames) ? exeNames.filter(Boolean).map(String) : [String(exeNames || '')].filter(Boolean);
  if (!list.length) return { ok: true, running: false, count: 0, pid: 0, exePath: '', byExe: {} };
  return runWinHelper(['find-proc', list.join(',')], { ...options, timeoutMs: options.timeoutMs || 5000 });
}

function queryRunningProcessPathSync(exeNames, options = {}) {
  if (process.platform !== 'win32') return null;
  const list = Array.isArray(exeNames) ? exeNames.filter(Boolean).map(String) : [String(exeNames || '')].filter(Boolean);
  if (!list.length) return null;
  try {
    const exe = ensureWinHelperCompiled(options.env);
    const out = execFileSync(exe, ['find-proc', list.join(',')], {
      encoding: 'utf8',
      timeout: options.timeoutMs || 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const lines = out.split(/\r?\n/);
    const parsed = JSON.parse(lines[lines.length - 1]);
    return parsed?.ok && parsed.exePath && fs.existsSync(parsed.exePath)
      ? { exePath: path.resolve(parsed.exePath), pid: parsed.pid || 0, count: parsed.count || 0, byExe: parsed.byExe || {} }
      : { exePath: null, pid: parsed?.pid || 0, count: parsed?.count || 0, byExe: parsed?.byExe || {} };
  } catch {
    return null;
  }
}

async function listSystemTrayIcons(options = {}) {
  if (process.platform !== 'win32') {
    return { ok: true, isInteractiveDefaultDesktop: false, chevronFound: false, overflowVisible: false, count: 0, icons: [] };
  }
  const openOverflow = options.openOverflow ? '1' : '0';
  const closeAfter = options.closeAfter === false ? '0' : '1';
  const res = await runWinHelper(['tray-list', openOverflow, closeAfter], { ...options, timeoutMs: options.timeoutMs || 8000 });
  const query = typeof options.find === 'string' ? options.find.trim().toLowerCase() : '';
  if (query && Array.isArray(res.icons)) {
    const matches = res.icons.filter(ic => String(ic?.name || '').toLowerCase().includes(query));
    return { ...res, matches };
  }
  return res;
}

async function activateSystemTrayIcon(options = {}) {
  if (process.platform !== 'win32') {
    throw desktopError('UNSUPPORTED_PLATFORM', 'activateSystemTrayIcon is only available on win32');
  }
  const includes = Array.isArray(options.keywords)
    ? options.keywords.map(s => String(s || '').trim()).filter(Boolean)
    : (typeof options.keyword === 'string' && options.keyword.trim() ? [options.keyword.trim()] : []);
  if (!includes.length) {
    throw desktopError('INVALID_ARGS', 'activateSystemTrayIcon requires at least one keyword');
  }
  const excludes = Array.isArray(options.excludeKeywords)
    ? options.excludeKeywords.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  const doubleFlag = options.doubleClick ? '1' : '0';
  return runWinHelper(
    ['tray-activate', includes.join(','), excludes.length ? excludes.join(',') : '-', doubleFlag],
    { ...options, mutating: true, timeoutMs: options.timeoutMs || 8000 },
  );
}

async function hashImageRegion(imagePath, options = {}) {
  const absPath = path.resolve(imagePath);
  if (!fs.existsSync(absPath)) {
    throw desktopError('INVALID_ARGS', 'Image file does not exist for region hash');
  }
  let cropArg = '-';
  if (options.region && options.region !== 'full' && options.region !== 'all') {
    const dims = readPngDimensionsFast(absPath);
    if (dims) {
      const crop = resolveRegionCrop(options.region, dims.width, dims.height);
      if (crop) cropArg = `${crop.x},${crop.y},${crop.width},${crop.height}`;
    } else if (typeof options.region === 'string' && /^\d+,\d+,\d+,\d+$/.test(options.region.trim())) {
      cropArg = options.region.trim();
    }
  }
  return runWinHelper(['region-hash', absPath, cropArg], options);
}

async function detectChatLayout(imagePath, options = {}) {
  const absPath = path.resolve(imagePath);
  if (!fs.existsSync(absPath)) {
    throw desktopError('INVALID_ARGS', 'Image file does not exist for chat-layout');
  }
  const raw = await runWinHelper(['chat-layout', absPath], options);
  const w = Number(raw.width) || 0;
  const h = Number(raw.height) || 0;
  if (!raw.detected || w <= 0 || h <= 0) {
    return { detected: false, width: w, height: h };
  }
  const sidebarRightX = raw.sidebarRightX > 0 ? raw.sidebarRightX : null;
  const rightDrawerLeftX = raw.rightDrawerLeftX > 0 ? raw.rightDrawerLeftX : null;
  const composerTopY = raw.composerTopY > 0 ? raw.composerTopY : null;
  const chatLeft = sidebarRightX ?? Math.round(w * 0.28);
  const chatRight = rightDrawerLeftX ?? w;
  const chatWidth = Math.max(40, chatRight - chatLeft);
  const compTop = composerTopY ?? Math.round(h * 0.66);
  const compHeight = Math.max(32, h - compTop);
  const headerBottom = Math.max(48, Math.min(120, Math.round(h * 0.15)));
  const messagesTop = Math.max(40, Math.min(84, Math.round(h * 0.09)));

  return {
    detected: true,
    width: w,
    height: h,
    sidebarRightX,
    rightDrawerLeftX,
    composerTopY,
    regions: {
      sidebar: `0,0,${Math.max(80, sidebarRightX ?? Math.round(w * 0.34))},${h}`,
      header: `${chatLeft},0,${chatWidth},${headerBottom}`,
      messages: `${chatLeft},${messagesTop},${chatWidth},${Math.max(40, compTop - messagesTop)}`,
      composer: `${chatLeft},${compTop},${chatWidth},${compHeight}`,
    },
    composerRatio: {
      xRatio: Number(((chatLeft + chatWidth * 0.5) / w).toFixed(4)),
      yRatio: Number(((compTop + compHeight * 0.45) / h).toFixed(4)),
    },
  };
}

module.exports = {
  HELPER_VERSION,
  ensureWinHelperCompiled,
  inspectDesktopEnvironment,
  assistForegroundWindow,
  launchDetachedViaShell,
  spawnClickRipple,
  prepareCoordinateCursor,
  restoreCursorPosition,
  postMessageClick,
  clickAndRestore,
  queryRunningProcessInfo,
  queryRunningProcessPathSync,
  listSystemTrayIcons,
  activateSystemTrayIcon,
  hashImageRegion,
  detectChatLayout,
  ocrImage,
  findOcrMatches,
  levenshteinDistance,
  foldOcrCjkRadicals,
  canonicalOcrKey,
  normalizeOcrText,
  compactSearchKey,
  resolveRegionCrop,
  mapRectToScreen,
  ensurePngImageFile,
  isPngFileHeader,
};
