[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ResultPath,
    [string]$WindowTitle = 'AgentBrowserBridge-window-smoke'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = $WindowTitle
$form.Width = 360
$form.Height = 160
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$label = New-Object System.Windows.Forms.Label
$label.Text = '窗口级桌面验收，向此框输入即可。'
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(20, 16)

$box = New-Object System.Windows.Forms.TextBox
$box.Width = 300
$box.Location = New-Object System.Drawing.Point(20, 50)
$form.Add_Shown({ $box.Focus() })

$box.Add_TextChanged({
    if ($box.Text) {
        Set-Content -LiteralPath $ResultPath -Value $box.Text -Encoding utf8
    }
})

$form.Controls.Add($label)
$form.Controls.Add($box)
[void]$form.ShowDialog()
