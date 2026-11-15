param(
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$StopPath,
  [Parameter(Mandatory = $true)][string]$WindowTitle
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$fixtureReferences = @([System.Windows.Forms.Form].Assembly.Location, [System.ComponentModel.Component].Assembly.Location)
Add-Type -ReferencedAssemblies $fixtureReferences -TypeDefinition @'
public sealed class BridgeWorkflowSmokeForm : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override System.Windows.Forms.CreateParams CreateParams {
    get {
      var result = base.CreateParams;
      result.ExStyle |= 0x08000000;
      return result;
    }
  }
}
'@
$form = New-Object BridgeWorkflowSmokeForm
$form.Text = $WindowTitle
$form.ShowInTaskbar = $false
$form.Size = New-Object System.Drawing.Size(430, 140)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(20, 20)
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Isolated automation fixture (no keyboard or mouse input)'
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(12, 12)
$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'workflow-result'
$box.AccessibleName = 'Workflow Result'
$box.Text = 'waiting'
$box.Width = 390
$box.Location = New-Object System.Drawing.Point(12, 40)
$form.Controls.Add($label)
$form.Controls.Add($box)
$form.Add_Shown({
  @{ windowId = 'w-' + $form.Handle.ToInt64(); pid = $PID; title = $WindowTitle } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $ReadyPath -Encoding utf8
})
$started = [DateTime]::UtcNow
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
  if ((Test-Path -LiteralPath $StopPath) -or ([DateTime]::UtcNow - $started).TotalSeconds -gt 120) {
    $timer.Stop()
    $form.Close()
  }
})
$timer.Start()
try { [System.Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose(); $form.Dispose() }
