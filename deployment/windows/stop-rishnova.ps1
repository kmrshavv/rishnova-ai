$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

try {
    Invoke-RishNovaControl -Path '/stop' -Method POST | Out-Null
}
catch {
    if (-not (Get-RishNovaControlInfo)) {
        Write-Output 'The RishNova supervisor is not running; no managed processes were stopped.'
        exit 0
    }
    throw
}

$deadline = [DateTime]::UtcNow.AddSeconds(100)
while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-RishNovaControlInfo)) {
        Write-Output 'RishNova FastAPI, tunnel, and any supervisor-started Ollama process stopped.'
        exit 0
    }
    Start-Sleep -Seconds 2
}
throw 'The RishNova supervisor did not stop within 100 seconds. Review logs\startup.log before retrying.'
