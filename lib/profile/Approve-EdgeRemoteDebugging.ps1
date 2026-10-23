[CmdletBinding()]
param(
    [int]$TimeoutSeconds = 40
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$btnCond = New-Object System.Windows.Automation.PropertyCondition (
    [System.Windows.Automation.AutomationElement]::NameProperty,
    '允许'
)
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$clicked = 0
while ((Get-Date) -lt $deadline) {
    $button = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    if ($button) {
        $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $clicked++
        Write-Output "clicked-allow-$clicked"
        Start-Sleep -Milliseconds 400
        continue
    }
    if ($clicked -gt 0 -and $clicked -ge 2) { exit 0 }
    Start-Sleep -Milliseconds 300
}

if ($clicked -gt 0) { exit 0 }
Write-Output 'allow-prompt-not-found'
exit 2
