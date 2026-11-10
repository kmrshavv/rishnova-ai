$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not (Test-Path -LiteralPath $script:RishNovaPython)) {
    throw "The project virtual environment is missing: $script:RishNovaPython. Create it and install backend\requirements.txt first."
}
if (-not (Test-Path -LiteralPath (Join-Path $script:RishNovaRoot '.env'))) {
    $example = Join-Path $script:RishNovaRoot '.env.example'
    if (-not (Test-Path -LiteralPath $example)) {
        throw 'The backend environment file is missing and no .env.example is available.'
    }
    Copy-Item -LiteralPath $example -Destination (Join-Path $script:RishNovaRoot '.env')
    Write-Warning 'Created .env from .env.example. Review its settings and set RISHNOVA_ADMIN_EMAILS before public use.'
}

& $script:RishNovaPython -c 'import fastapi, httpx, jwt, ollama, uvicorn'
if ($LASTEXITCODE -ne 0) {
    throw 'The backend virtual environment is missing required packages. Install backend\requirements.txt, then rerun this script.'
}

$cloudflared = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
if (-not $cloudflared) {
    $knownPaths = @(
        (Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'),
        (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe')
    )
    if (-not ($knownPaths | Where-Object { Test-Path -LiteralPath $_ })) {
        throw 'cloudflared.exe is not installed. Install Cloudflare Tunnel, then rerun this script.'
    }
}

$logs = Join-Path $script:RishNovaRoot 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
foreach ($name in @('startup.log', 'backend.log', 'tunnel.log', 'health.log')) {
    $path = Join-Path $logs $name
    if (-not (Test-Path -LiteralPath $path)) {
        New-Item -ItemType File -Path $path | Out-Null
    }
}
New-Item -ItemType Directory -Path $script:RishNovaState -Force | Out-Null

& (Join-Path $PSScriptRoot 'configure-task-scheduler.ps1')

Start-ScheduledTask -TaskName $script:RishNovaTaskName
Write-Output 'RishNova startup and shutdown tasks are installed and starting for the current Windows user.'
Write-Output 'A stable public API requires a domain you control in Cloudflare; no temporary tunnel has been configured.'
Write-Output 'After completing Cloudflare setup, set the Pages BACKEND_API_URL variable to your HTTPS API origin and redeploy Pages.'
