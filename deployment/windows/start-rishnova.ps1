$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

try {
    Invoke-RishNovaControl -Path '/start' -Method POST | Out-Null
    Write-Output 'Requested startup or recovery from the RishNova supervisor.'
    exit 0
}
catch {
    if (Get-RishNovaControlInfo) {
        throw
    }
}

$task = Get-RishNovaTask
if ($task) {
    Assert-RishNovaTaskOwned -Task $task
    Start-ScheduledTask -TaskName $script:RishNovaTaskName
}
else {
    $powershell = Join-Path $PSHOME 'powershell.exe'
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $PSScriptRoot 'startup.ps1')
    Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory $script:RishNovaRoot -WindowStyle Hidden
}

Write-Output 'Started the RishNova supervisor. Check deployment\windows\health-check.ps1 for status.'
