[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'AgentBrowserBridge-desktop-smoke'
$form.Width = 360
$form.Height = 160
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$label = New-Object System.Windows.Forms.Label
$label.Text = '桌面控制验收，点“允许”即可。'
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(20, 20)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = '允许'
$btn.Width = 100
$btn.Height = 28
$btn.Location = New-Object System.Drawing.Point(20, 70)
$btn.Add_Click({
    Set-Content -LiteralPath $ResultPath -Value 'clicked' -Encoding utf8
    $form.Close()
})

$form.Controls.Add($label)
$form.Controls.Add($btn)
$form.AcceptButton = $btn
[void]$form.ShowDialog()
