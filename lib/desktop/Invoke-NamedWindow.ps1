[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Focus', 'Keys', 'Capture')]
    [string]$Action,
    [Parameter(Mandatory)]
    [string]$WindowTitle,
    [string]$Keys = '',
    [string]$OutputPath = '',
    [int]$TimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($WindowTitle)) { throw 'Named window title required' }
if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 60) { throw 'Named window timeout must be 1-60 seconds' }
if ($Action -eq 'Keys') {
    if ([string]::IsNullOrWhiteSpace($Keys)) { throw 'Named window keys required' }
    if ($Keys.Length -gt 200) { throw 'Named window keys too long' }
    if ($Keys -match '%\{F4\}|!\{F4\}') { throw 'Refusing Alt+F4; this bridge does not close windows' }
}
if ($Action -eq 'Capture' -and [string]::IsNullOrWhiteSpace($OutputPath)) { throw 'Capture output path required' }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NamedWindowNative {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
}
"@

function Find-NamedWindow([string]$Title) {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition (
        [System.Windows.Automation.AutomationElement]::NameProperty,
        $Title
    )
    $found = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($found.Count -eq 0) {
        $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    }
    if ($found.Count -eq 0) { return $null }
    if ($found.Count -gt 1) { throw "Named window is not unique: $Title" }
    return $found[0]
}

function Show-NamedWindow($window) {
    $hwnd = [IntPtr]$window.Current.NativeWindowHandle
    if ($hwnd -eq [IntPtr]::Zero) { throw 'Named window has no HWND' }
    $unused = 0
    $currentTid = [NamedWindowNative]::GetCurrentThreadId()
    $targetTid = [NamedWindowNative]::GetWindowThreadProcessId($hwnd, [ref]$unused)
    $front = [NamedWindowNative]::GetForegroundWindow()
    $frontTid = 0
    if ($front -ne [IntPtr]::Zero) {
        $frontTid = [NamedWindowNative]::GetWindowThreadProcessId($front, [ref]$unused)
    }
    if ($targetTid -ne 0) { [void][NamedWindowNative]::AttachThreadInput($currentTid, $targetTid, $true) }
    if ($frontTid -ne 0 -and $frontTid -ne $targetTid) { [void][NamedWindowNative]::AttachThreadInput($currentTid, $frontTid, $true) }
    [void][NamedWindowNative]::ShowWindow($hwnd, 9)
    [void][NamedWindowNative]::BringWindowToTop($hwnd)
    [void][NamedWindowNative]::SetForegroundWindow($hwnd)
    if ($frontTid -ne 0 -and $frontTid -ne $targetTid) { [void][NamedWindowNative]::AttachThreadInput($currentTid, $frontTid, $false) }
    if ($targetTid -ne 0) { [void][NamedWindowNative]::AttachThreadInput($currentTid, $targetTid, $false) }
    $editType = New-Object System.Windows.Automation.PropertyCondition (
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit
    )
    $edit = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editType)
    if ($edit) {
        try { $edit.SetFocus() } catch { }
    }
    return [int]$hwnd
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$window = $null
while ((Get-Date) -lt $deadline) {
    $window = Find-NamedWindow $WindowTitle
    if ($window) { break }
    Start-Sleep -Milliseconds 250
}
if (-not $window) {
    Write-Output 'named-window-not-found'
    exit 2
}

$hwnd = Show-NamedWindow $window
Start-Sleep -Milliseconds 200

if ($Action -eq 'Focus') {
    Write-Output (@{ ok = $true; action = 'focus'; title = $window.Current.Name; hwnd = $hwnd } | ConvertTo-Json -Compress)
    exit 0
}

if ($Action -eq 'Keys') {
    $editType = New-Object System.Windows.Automation.PropertyCondition (
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit
    )
    $edit = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editType)
    $plain = $Keys -notmatch '[\^%~{}+]'
    $via = 'sendkeys'
    if ($edit -and $plain) {
        try {
            $edit.SetFocus()
            $value = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $value.SetValue($Keys)
            $readback = $value.Current.Value
            if ($readback -ne $Keys) { throw "ValuePattern readback mismatch: $readback" }
            $via = 'value'
            Start-Sleep -Milliseconds 200
        } catch {
            [System.Windows.Forms.SendKeys]::SendWait('^a{DEL}')
            Start-Sleep -Milliseconds 50
            [System.Windows.Forms.SendKeys]::SendWait($Keys)
        }
    } else {
        [System.Windows.Forms.SendKeys]::SendWait($Keys)
    }
    Write-Output (@{ ok = $true; action = 'keys'; title = $window.Current.Name; hwnd = $hwnd; via = $via } | ConvertTo-Json -Compress)
    exit 0
}

$rect = $window.Current.BoundingRectangle
$width = [Math]::Max(1, [int][Math]::Round($rect.Width))
$height = [Math]::Max(1, [int][Math]::Round($rect.Height))
$bmp = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
try {
    $graphics.CopyFromScreen([int][Math]::Round($rect.X), [int][Math]::Round($rect.Y), 0, 0, $bmp.Size)
    $dir = Split-Path -Parent $OutputPath
    if ($dir) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bmp.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $graphics.Dispose()
    $bmp.Dispose()
}
Write-Output (@{
    ok = $true
    action = 'capture'
    title = $window.Current.Name
    hwnd = $hwnd
    path = $OutputPath
    width = $width
    height = $height
} | ConvertTo-Json -Compress)
exit 0
