[CmdletBinding()]
param(
    [ValidateSet('Edge', 'Chrome')]
    [string]$Browser = 'Edge',
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$')]
    [string]$Scene = 'default',
    [ValidateRange(1024, 65535)]
    [int]$Port = 9222,
    [string]$ProfileRoot = '',
    [string]$ExecutablePath = '',
    [string]$Url = ''
)

$ErrorActionPreference = 'Stop'

if (-not $ProfileRoot) {
    $ProfileRoot = Join-Path $env:LOCALAPPDATA ("AgentBrowserBridge\profiles\" + $Browser + "-" + $Scene)
}
$ProfileRoot = [System.IO.Path]::GetFullPath($ProfileRoot)
$dailyProfiles = @(
    [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data')),
    [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'))
)
$separator = [System.IO.Path]::DirectorySeparatorChar
foreach ($dailyProfile in $dailyProfiles) {
    $dailyPrefix = $dailyProfile.TrimEnd($separator) + $separator
    $isDaily = $ProfileRoot.Equals($dailyProfile, [System.StringComparison]::OrdinalIgnoreCase) -or
        $ProfileRoot.StartsWith($dailyPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    if ($isDaily) {
        throw '不能把日常浏览器配置目录用作桥接目录。请使用独立目录。'
    }
}

$pf86 = [System.Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
if (-not $ExecutablePath) {
    if ($Browser -eq 'Edge') {
        $candidates = @(
            "$pf86\Microsoft\Edge\Application\msedge.exe",
            "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
            "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
        )
    } else {
        $candidates = @(
            "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "$pf86\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
        )
    }
    $ExecutablePath = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}
if (-not $ExecutablePath -or -not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw "未找到 $Browser。请安装浏览器，或通过 -ExecutablePath 指定其程序路径。"
}

function Get-CommandFlag([string]$Command, [string]$Name) {
    $pattern = '(?:^|\s)' + [regex]::Escape($Name) + '=(?:"([^"]+)"|(\S+))'
    $match = [regex]::Match($Command, $pattern)
    if (-not $match.Success) { return $null }
    if ($match.Groups[1].Value) { return $match.Groups[1].Value }
    return $match.Groups[2].Value
}

function Test-CdpReady([int]$ListenPort) {
    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$ListenPort/json/version" -TimeoutSec 2
        return [bool]$version.Browser
    } catch {
        return $false
    }
}

$processName = [System.IO.Path]::GetFileName($ExecutablePath)
$running = @(Get-CimInstance Win32_Process -Filter "Name='$processName'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($ProfileRoot.ToLower()) })
if ($running.Count -gt 0) {
    $actualPort = [int](Get-CommandFlag $running[0].CommandLine '--remote-debugging-port')
    if (-not $actualPort) { throw '专用窗口已在运行，但读不到远程调试端口。请检查该窗口后重试。' }
    if (-not (Test-CdpReady $actualPort)) {
        throw "专用窗口已在运行，但 http://127.0.0.1:$actualPort/json/version 未就绪。未关闭浏览器。"
    }
    Write-Host "$Browser 专用窗口已在运行，复用现有连接。"
    Write-Host "本地桥接：http://127.0.0.1:$actualPort"
    Write-Host "配置目录：$ProfileRoot"
    Write-Host '登录先查 Obsidian 密码簿；不要把该配置目录提交到 Git。'
    exit 0
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listener) {
    throw "本地端口 $Port 已被占用。为避免连错浏览器，请换一个空闲端口。"
}

New-Item -ItemType Directory -Path $ProfileRoot -Force | Out-Null
$quote = [char]34
$arguments = @(
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$Port",
    '--remote-allow-origins=http://agent-browser-bridge.invalid',
    ('--user-data-dir=' + $quote + $ProfileRoot + $quote),
    '--no-first-run',
    '--no-default-browser-check'
)
if ($Url) { $arguments += ($quote + $Url + $quote) }

$process = Start-Process -FilePath $ExecutablePath -ArgumentList $arguments -PassThru
$endpoint = "http://127.0.0.1:$Port"
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $version = Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2
        if ($version.Browser) {
            $ready = $true
            break
        }
    } catch {
        if ($process.HasExited) { break }
    }
}
if (-not $ready) {
    throw "$Browser 已启动，但本地桥接端口未就绪。未关闭浏览器；请检查该窗口后重试。"
}

Write-Host "$Browser 专用窗口已启动。"
Write-Host "本地桥接：$endpoint"
Write-Host "配置目录：$ProfileRoot"
Write-Host '登录先查 Obsidian 密码簿，在此窗口登录一次即可复用。'
Write-Host '不要把该配置目录提交到 Git。'
