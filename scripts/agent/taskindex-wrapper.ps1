# Обёртка CLI taskindex для Windows (PowerShell 7): подставляет ключ агента по
# среде запуска, как taskindex-wrapper.sh на маке. Claude Code на Windows ходит
# через Git Bash и берёт sh-обёртку рядом; этот файл для Codex, OpenClaw и
# ручного запуска из pwsh/cmd (через taskindex.cmd). Ставится
# scripts/agent/install-win.ps1 как ~\.local\bin\taskindex.ps1.
$ErrorActionPreference = 'Stop'
# CLI печатает JSON в UTF-8; консоль Windows по умолчанию в OEM-кодировке.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliRoot = Join-Path $HOME '.local\lib\taskindex-cli\node_modules\taskindex'
$restore = @{}
if (-not $env:TASKINDEX_TOKEN) {
  $agent = $env:TASKINDEX_AGENT
  if (-not $agent -and $env:OPENCLAW_SERVICE_MARKER) { $agent = 'openclaw-win' }
  if (-not $agent -and $env:CLAUDECODE) { $agent = 'claude-win' }
  if (-not $agent -and $env:CODEX_THREAD_ID) { $agent = 'codex-win' }
  if (-not $agent) {
    Write-Output '{"ok":false,"code":"client_error","message":"Не определён агент: задайте TASKINDEX_AGENT (claude-win, codex-win, openclaw-win) или TASKINDEX_URL и TASKINDEX_TOKEN","retryable":false}'
    exit 1
  }
  $envFile = Join-Path $HOME ".config\taskindex\$agent.env"
  if (-not (Test-Path $envFile)) {
    Write-Output ('{"ok":false,"code":"client_error","message":"Нет файла ключа ' + $envFile.Replace('\', '\\') + '","retryable":false}')
    exit 1
  }
  # pwsh запускает .ps1 из PATH в своей же сессии: ключ ставится только на время
  # вызова и снимается после, чтобы не остаться в переменных вызывающего.
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^([A-Za-z_]+)=(.*)$') {
      $restore[$Matches[1]] = [Environment]::GetEnvironmentVariable($Matches[1], 'Process')
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
  }
}
try {
  & node (Join-Path $cliRoot 'dist\cli\index.js') @args
  $code = $LASTEXITCODE
} finally {
  foreach ($k in $restore.Keys) { [Environment]::SetEnvironmentVariable($k, $restore[$k], 'Process') }
}
exit $code
