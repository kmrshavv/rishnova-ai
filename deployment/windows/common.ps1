$script:RishNovaRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:RishNovaState = Join-Path $env:LOCALAPPDATA 'RishNovaAI'
$script:RishNovaControlFile = Join-Path $script:RishNovaState 'control.json'
$script:RishNovaTaskName = 'RishNova AI Server (User)'
$script:RishNovaShutdownTaskName = 'RishNova AI Shutdown (User)'
$script:RishNovaTaskMarker = 'Managed by the RishNova AI Windows deployment.'
$script:RishNovaPython = Join-Path $script:RishNovaRoot 'backend\venv\Scripts\python.exe'
$script:RishNovaSupervisor = Join-Path $PSScriptRoot 'supervisor.py'

function Get-RishNovaControlInfo {
    if (-not (Test-Path -LiteralPath $script:RishNovaControlFile)) {
        return $null
    }

    try {
        $info = Get-Content -LiteralPath $script:RishNovaControlFile -Raw | ConvertFrom-Json
    }
    catch {
        throw 'The RishNova supervisor control file is invalid. Inspect logs\startup.log.'
    }

    if ($info.host -ne '127.0.0.1' -or $info.port -ne 47831 -or -not $info.token) {
        throw 'The RishNova supervisor control file contains invalid values.'
    }
    return $info
}

function Invoke-RishNovaControl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet('GET', 'POST')][string]$Method = 'GET'
    )

    $info = Get-RishNovaControlInfo
    if (-not $info) {
        throw 'The RishNova supervisor is not running.'
    }
    $headers = @{ Authorization = "Bearer $($info.token)" }
    try {
        return Invoke-RestMethod `
            -Uri "http://127.0.0.1:47831$Path" `
            -Method $Method `
            -Headers $headers `
            -UseBasicParsing `
            -TimeoutSec 5
    }
    catch {
        throw "Could not contact the RishNova supervisor: $($_.Exception.Message)"
    }
}

function Get-RishNovaTask {
    try {
        return Get-ScheduledTask -TaskName $script:RishNovaTaskName -ErrorAction Stop
    }
    catch {
        return $null
    }
}

function Get-RishNovaShutdownTask {
    try {
        return Get-ScheduledTask -TaskName $script:RishNovaShutdownTaskName -ErrorAction Stop
    }
    catch {
        return $null
    }
}

function Assert-RishNovaTaskOwned {
    param([Parameter(Mandatory = $true)]$Task)
    if ($Task.Description -ne $script:RishNovaTaskMarker) {
        throw "A scheduled task named '$script:RishNovaTaskName' already exists and is not owned by this deployment."
    }
}
