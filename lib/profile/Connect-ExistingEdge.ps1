[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$edgeData = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'
$activePortFile = Join-Path $edgeData 'DevToolsActivePort'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

$policyValues = @()
foreach ($policyPath in @('HKLM:\SOFTWARE\Policies\Microsoft\Edge', 'HKCU:\SOFTWARE\Policies\Microsoft\Edge')) {
    try {
        $value = Get-ItemPropertyValue -Path $policyPath -Name RemoteDebuggingAllowed -ErrorAction Stop
        $policyValues += [int]$value
    } catch { }
}
if ($policyValues -contains 0) {
    throw 'Edge 策略禁止远程调试。脚本没有修改系统策略；请联系管理员调整 RemoteDebuggingAllowed。'
}

function Get-ExistingEdgeMainProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '(?:^|\s)--type=' })
}

function Get-ExistingEdgePort {
    if (-not (Test-Path -LiteralPath $activePortFile)) { return $null }
    try {
        $lines = @(Get-Content -LiteralPath $activePortFile -ErrorAction Stop)
        $candidate = 0
        if ($lines.Count -lt 2 -or -not [int]::TryParse($lines[0], [ref]$candidate) -or
            $candidate -lt 1024 -or $candidate -gt 65535 -or
            $lines[1] -notmatch '^/devtools/browser/[0-9a-f-]+$') { return $null }

        $main = Get-ExistingEdgeMainProcesses
        if ($main.Count -ne 1) { return $null }
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue)
        if (-not $listeners -or @($listeners | Where-Object { $_.OwningProcess -eq $main[0].ProcessId }).Count -eq 0) { return $null }
        if (@($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }).Count -gt 0) { return $null }
        return $candidate
    } catch { return $null }
}

$mainProcesses = Get-ExistingEdgeMainProcesses
if ($mainProcesses.Count -gt 1) {
    throw '检测到多个 Edge 主进程，无法安全确认 profile；脚本没有关闭或切换任何窗口。'
}
if ($mainProcesses.Count -eq 0) {
    throw '没有正在运行的普通 Edge。请先打开日常 Edge，并在 edge://inspect/#remote-debugging 勾选允许远程调试。此脚本不会启动或关闭浏览器。'
}

$port = Get-ExistingEdgePort
if (-not $port) {
    throw 'Edge 已运行，但没有有效的 DevToolsActivePort。请打开 edge://inspect/#remote-debugging 勾选“允许对此浏览器实例进行远程调试”，不要反复重启默认 profile。'
}

Write-Host "即将连接当前已登录的 Edge（127.0.0.1:$port）。首次会弹出远程调试授权，脚本会点“允许”；之后复用本机 127.0.0.1:19322 代理，不应再弹。不会关闭或新开浏览器。"

$env:CDP_HTTP = "http://127.0.0.1:$port"
$env:BROWSER_BRIDGE_REQUIRE_INSTANCE = '1'
$env:BROWSER_BRIDGE_ATTACH_EXISTING = '1'
$env:BROWSER_BRIDGE_EXPECT_PROFILE = $edgeData
$env:BROWSER_BRIDGE_EXPECT_PROXY = 'none'
$env:BROWSER_BRIDGE_EXPECT_BROWSER = 'edge'
$env:BROWSER_BRIDGE_WS_TIMEOUT_MS = '45000'

$approver = Start-Process -FilePath 'pwsh' -ArgumentList @(
    '-NoProfile',
    '-File',
    (Join-Path $PSScriptRoot 'Approve-EdgeRemoteDebugging.ps1'),
    '-TimeoutSeconds',
    '40'
) -WindowStyle Hidden -PassThru

Push-Location $repoRoot
try {
    npm run check
    if ($LASTEXITCODE -ne 0) { throw '现有 Edge 实例身份校验失败。若授权框仍在，请手动点击允许后再运行一次。' }
} finally {
    if ($approver -and -not $approver.HasExited) {
        Stop-Process -Id $approver.Id -Force -ErrorAction SilentlyContinue
    }
    Pop-Location
}

Write-Host "Edge 默认 profile 桥接验证成功：127.0.0.1:$port"
