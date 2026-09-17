# Установка CLI taskindex и скилла для агентов на Windows-ПК владельца (pwsh 7).
# Запуск из корня чекаута:
#   pwsh -File scripts/agent/install-win.ps1 -Tarball C:\path\taskindex-2.0.0.tgz
#   pwsh -File scripts/agent/install-win.ps1            # собрать и упаковать здесь
# Делает то же, что install-mac.sh: пакет в свой префикс ~\.local\lib\taskindex-cli,
# обёртки ~\.local\bin\taskindex (sh, для Git Bash и Claude Code), taskindex.cmd и
# taskindex.ps1 (Codex, pwsh), каталог ключей ~\.config\taskindex, копии скилла в
# ~\.claude\skills и ~\.agents\skills (симлинки на Windows требуют прав), PATH
# пользователя. Ключи не создаёт: см. README, раздел «Агенты».
param([string]$Tarball)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
node scripts/preflight.mjs
if (-not $Tarball) {
  npm run -s build | Out-Null
  $Tarball = (npm pack --silent | Select-Object -Last 1)
}
$Tarball = (Resolve-Path $Tarball).Path
$prefix = Join-Path $HOME '.local\lib\taskindex-cli'
$bin = Join-Path $HOME '.local\bin'
$config = Join-Path $HOME '.config\taskindex'
foreach ($dir in $prefix, $bin, $config) { New-Item -ItemType Directory -Force $dir | Out-Null }
Write-Host "npm i -g --prefix $prefix $Tarball"
npm i -g --silent --prefix $prefix $Tarball
$cliRoot = Join-Path $prefix 'node_modules\taskindex'
if (-not (Test-Path (Join-Path $cliRoot 'dist\cli\index.js'))) { throw "не найден $cliRoot\dist\cli\index.js" }

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$sh = Get-Content (Join-Path $root 'scripts\agent\taskindex-wrapper.sh') -Raw
$sh = $sh -replace "^#!/bin/sh\r?\n", ''
$header = "#!/bin/sh`n# Сгенерировано scripts/agent/install-win.ps1 $stamp из $root`n" +
  "TASKINDEX_CLI_ROOT=`"`$HOME/.local/lib/taskindex-cli/node_modules/taskindex`"; export TASKINDEX_CLI_ROOT`n" +
  "TASKINDEX_MACHINE=`"win`"; export TASKINDEX_MACHINE`n"
[IO.File]::WriteAllText((Join-Path $bin 'taskindex'), ($header + $sh).Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
Copy-Item (Join-Path $root 'scripts\agent\taskindex-wrapper.ps1') (Join-Path $bin 'taskindex.ps1') -Force
Copy-Item (Join-Path $root 'scripts\agent\taskindex-wrapper.cmd') (Join-Path $bin 'taskindex.cmd') -Force

foreach ($dir in (Join-Path $HOME '.claude\skills'), (Join-Path $HOME '.agents\skills')) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  $target = Join-Path $dir 'taskindex'
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  Copy-Item (Join-Path $root 'skills\taskindex') $target -Recurse
}
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $bin) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin), 'User')
  Write-Host "PATH пользователя: добавлен $bin (новые окна его увидят)"
}
$version = (Get-Content (Join-Path $cliRoot 'package.json') | ConvertFrom-Json).version
Write-Host @"
Готово:
  CLI        $cliRoot (версия $version)
  обёртки    $bin\taskindex (Git Bash), $bin\taskindex.cmd, $bin\taskindex.ps1
  ключи      $config\<agent>.env  (TASKINDEX_URL=…, TASKINDEX_TOKEN=…)
  скилл      ~\.claude\skills\taskindex и ~\.agents\skills\taskindex (копии)
Проверка:    `$env:TASKINDEX_AGENT='claude-win'; taskindex me
"@
