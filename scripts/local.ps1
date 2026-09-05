param([ValidateSet('install','ci','build','typecheck','test','lint','start','dev')][string]$Command = 'start')
$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $workspace
$bundled = Join-Path $workspace '.tools/node-v24.20.0-win-x64'
if (Test-Path -LiteralPath (Join-Path $bundled 'node.exe')) { $env:PATH = "$bundled;" + $env:PATH }
if ((node -p 'process.versions.node.split(".")[0]') -ne '24') { throw '请先安装 Node.js 24 LTS。' }
if ($Command -in @('install','ci')) { npm $Command } else { npm run $Command }
exit $LASTEXITCODE
