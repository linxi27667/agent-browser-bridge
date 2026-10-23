[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ButtonName,
    [string]$WindowTitle = '',
    [int]$TimeoutSeconds = 10,
    [int]$MaxClicks = 1
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ButtonName)) { throw 'Named desktop button required' }
if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 60) { throw 'Desktop click timeout must be 1-60 seconds' }
if ($MaxClicks -lt 1 -or $MaxClicks -gt 3) { throw 'Desktop click count must be 1-3' }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$btnCond = New-Object System.Windows.Automation.PropertyCondition (
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $ButtonName
)
$winCond = $null
if (-not [string]::IsNullOrWhiteSpace($WindowTitle)) {
    $winCond = New-Object System.Windows.Automation.PropertyCondition (
        [System.Windows.Automation.AutomationElement]::NameProperty,
        $WindowTitle
    )
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$clicked = 0
while ((Get-Date) -lt $deadline) {
    $searchRoot = $root
    if ($winCond) {
        $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $winCond)
        if (-not $window) {
            $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $winCond)
        }
        if (-not $window) {
            Start-Sleep -Milliseconds 250
            continue
        }
        $searchRoot = $window
    }
    $button = $searchRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    if ($button) {
        $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $clicked++
        Write-Output "clicked-$clicked"
        if ($clicked -ge $MaxClicks) { exit 0 }
        Start-Sleep -Milliseconds 300
        continue
    }
    Start-Sleep -Milliseconds 250
}

if ($clicked -gt 0) { exit 0 }
Write-Output 'named-button-not-found'
exit 2
