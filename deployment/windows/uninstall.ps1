$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$task = Get-RishNovaTask
$shutdownTask = Get-RishNovaShutdownTask
if ($task) {
    Assert-RishNovaTaskOwned -Task $task
}
if ($shutdownTask) {
    Assert-RishNovaTaskOwned -Task $shutdownTask
}

try {
    & (Join-Path $PSScriptRoot 'stop-rishnova.ps1')
}
catch {
    throw "Uninstall stopped without removing the scheduled task: $($_.Exception.Message)"
}

if ($task -or $shutdownTask) {
    & (Join-Path $PSScriptRoot 'configure-task-scheduler.ps1') -Uninstall
}

Write-Output 'Removed only the RishNova startup and shutdown tasks. Logs, tunnel credentials/configuration, Ollama, and model files were preserved.'
