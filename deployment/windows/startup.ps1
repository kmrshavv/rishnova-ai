$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not (Test-Path -LiteralPath $script:RishNovaPython)) {
    throw "Backend Python was not found: $script:RishNovaPython"
}
if (-not (Test-Path -LiteralPath $script:RishNovaSupervisor)) {
    throw "RishNova supervisor was not found: $script:RishNovaSupervisor"
}

New-Item -ItemType Directory -Path (Join-Path $script:RishNovaRoot 'logs') -Force | Out-Null
Push-Location $script:RishNovaRoot
try {
    & $script:RishNovaPython $script:RishNovaSupervisor
    if ($LASTEXITCODE -ne 0) {
        throw "RishNova supervisor exited with code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
