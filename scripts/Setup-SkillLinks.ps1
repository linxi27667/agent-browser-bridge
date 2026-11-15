<#
.SYNOPSIS
    重建 AI 工具的 Skill 发现入口（Directory Junction）。

.DESCRIPTION
    skills/ 是项目内便携技能源。本脚本在项目根创建 .agents/skills、.claude/skills、
    .codex/skills 与 .cursor/skills 四个 junction 指向 skills/。这些入口不入库（见 .gitignore），
    clone 仓库后运行本脚本即可让所有 AI IDE 自动发现项目技能。

.EXAMPLE
    pwsh -NoProfile -File scripts/Setup-SkillLinks.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$target = Join-Path $root 'skills'

foreach ($tool in @('.agents', '.claude', '.codex', '.cursor')) {
    $linkDir = Join-Path $root $tool
    $link = Join-Path $linkDir 'skills'
    if (-not (Test-Path -LiteralPath $linkDir)) {
        New-Item -ItemType Directory -Path $linkDir -Force | Out-Null
    }
    if (Test-Path -LiteralPath $link) {
        $item = Get-Item -LiteralPath $link -Force
        $resolvedTarget = @($item.Target) | Select-Object -First 1
        if ($item.LinkType -eq 'Junction' -and $resolvedTarget -and
            ([IO.Path]::GetFullPath($resolvedTarget) -eq [IO.Path]::GetFullPath($target))) {
            Write-Host "已存在且目标正确: $link" -ForegroundColor DarkGray
            continue
        }
        throw "发现非预期的 Skill 入口，未自动覆盖: $link。请先核对并迁移其中的独有内容。"
    }
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    Write-Host "已创建 junction: $link -> $target" -ForegroundColor Green
}
