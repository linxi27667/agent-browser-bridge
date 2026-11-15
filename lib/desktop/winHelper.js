const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { desktopError } = require('./agentDesktopProcess');

const HELPER_VERSION = 'win-helper-v3';

const CSHARP_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
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

  private const int UOI_NAME = 2;
  private const uint DESKTOP_READOBJECTS = 0x0001;
  private const int SW_RESTORE = 9;
  private const int SW_SHOW = 5;
  private const byte VK_MENU = 0x12;
  private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  private const uint KEYEVENTF_KEYUP = 0x0002;
  private const uint MONITOR_DEFAULTTONEAREST = 2;
  private const uint SWP_NOZORDER = 0x0004;
  private const uint SWP_NOACTIVATE = 0x0010;

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

  const refs = [
    'System.Drawing.dll',
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
        if (parsed && parsed.ok === true) {
          resolve(parsed);
          return;
        }
        if (parsed && parsed.ok === false) {
          reject(desktopError(parsed.code || 'WIN_HELPER_FAILED', parsed.message || 'Windows helper failed'));
          return;
        }
        if (error) {
          if (error.name === 'AbortError' || options.signal?.aborted) {
            reject(desktopError('ABORTED', 'Windows helper call was aborted'));
            return;
          }
          reject(desktopError('WIN_HELPER_FAILED', error.message || 'Windows helper process failed'));
          return;
        }
        reject(desktopError('WIN_HELPER_PROTOCOL_ERROR', 'Windows helper returned invalid JSON'));
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

function findTightWordSpan(line, needleCompact, maxDist = 0) {
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
        if (!best || best.distance > 0 || spanLen < best.spanLen) {
          const subWords = words.slice(start, end + 1);
          best = {
            distance: 0,
            spanLen,
            matchedText: normalizeOcrText(subWords.map(w => w.text).join(' ')),
            imageRect: unionWordRect(subWords),
          };
        }
        break;
      }
      if (maxDist > 0 && Math.abs(acc.length - needleCompact.length) <= maxDist) {
        const dist = levenshteinDistance(acc, needleCompact);
        if (dist <= maxDist) {
          const spanLen = acc.length;
          if (!best || dist < best.distance || (dist === best.distance && Math.abs(spanLen - needleCompact.length) < Math.abs(best.spanLen - needleCompact.length))) {
            const subWords = words.slice(start, end + 1);
            best = {
              distance: dist,
              spanLen,
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
  const maxDist = allowedOcrEditDistance(needle, Boolean(options.strictExact));
  const matches = [];
  const lines = Array.isArray(ocrData?.lines) ? ocrData.lines : [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const lineCompact = compactSearchKey(line.text || line.rawText || '');
    if (!lineCompact) continue;
    const directHit = lineCompact.includes(needle);
    const tight = findTightWordSpan(line, needle, maxDist);
    let distance = directHit ? 0 : (tight ? tight.distance : Infinity);
    if (!directHit && distance > maxDist && maxDist > 0 && Math.abs(lineCompact.length - needle.length) <= maxDist) {
      const lineDist = levenshteinDistance(lineCompact, needle);
      if (lineDist <= maxDist) distance = lineDist;
    }
    if (distance > maxDist) continue;
    const exact = directHit && lineCompact === needle;
    const imgRect = tight ? tight.imageRect : { x: line.x, y: line.y, width: line.width, height: line.height };
    const screen = mapRectToScreen(imgRect, ocrData.imageWidth, ocrData.imageHeight, bounds);
    matches.push({
      lineIndex,
      lineText: line.text,
      matchedText: tight ? tight.matchedText : line.text,
      exact,
      distance,
      confidence: distance === 0 ? 'exact' : 'ocr_fuzzy_1',
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
  hashImageRegion,
  detectChatLayout,
  ocrImage,
  findOcrMatches,
  normalizeOcrText,
  compactSearchKey,
  resolveRegionCrop,
  mapRectToScreen,
  ensurePngImageFile,
  isPngFileHeader,
};
