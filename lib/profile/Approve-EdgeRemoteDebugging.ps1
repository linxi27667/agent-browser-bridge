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
while ((Get-Date) -lt $deadline) {
    $button = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    if ($button) {
        $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Write-Output 'clicked-allow'
        exit 0
    }
    Start-Sleep -Milliseconds 300
}

Write-Output 'allow-prompt-not-found'
exit 2
