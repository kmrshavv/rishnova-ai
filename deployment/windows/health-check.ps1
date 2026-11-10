$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$status = $null
try {
    $status = Invoke-RishNovaControl -Path '/status'
}
catch {
    if (Test-Path -LiteralPath (Join-Path $script:RishNovaState 'status.json')) {
        try {
            $status = Get-Content -LiteralPath (Join-Path $script:RishNovaState 'status.json') -Raw | ConvertFrom-Json
        }
        catch {
            Write-Warning 'Saved supervisor status is unreadable.'
        }
    }
}

function Get-LocalJsonStatus {
    param([string]$Uri, [string]$ExpectedProperty)
    try {
        $response = Invoke-RestMethod -Uri $Uri -Method Get -UseBasicParsing -TimeoutSec 5
        if ($ExpectedProperty -and $response.$ExpectedProperty) {
            return [string]$response.$ExpectedProperty
        }
        return 'online'
    }
    catch {
        return 'offline'
    }
}

try {
    $null = Invoke-WebRequest -Uri 'https://www.cloudflare.com/cdn-cgi/trace' -UseBasicParsing -TimeoutSec 8
    $internet = 'online'
}
catch {
    $internet = 'offline'
}
$ollama = Get-LocalJsonStatus -Uri 'http://127.0.0.1:11434/api/tags'
$model = 'unknown'
try {
    $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -UseBasicParsing -TimeoutSec 5
    if (@($tags.models | Where-Object { $_.name -eq 'qwen3.5:0.8b' -or $_.model -eq 'qwen3.5:0.8b' }).Count -gt 0) {
        $model = 'available'
    }
    else {
        $model = 'missing'
    }
}
catch {
    $model = 'offline'
}
$backend = Get-LocalJsonStatus -Uri 'http://127.0.0.1:8000/health/ready'
$tunnel = if ($status) { $status.tunnel } else { 'unknown' }
$publicApi = if ($status) { $status.public_api } else { 'unknown' }
$publicApiUrl = if ($status) { $status.public_api_url } else { '' }
$lastError = if ($status) { $status.last_startup_error } else { 'No supervisor status is available.' }

$quickTunnelConfig = Join-Path $script:RishNovaState 'quick-tunnel.json'
if (Test-Path -LiteralPath $quickTunnelConfig) {
    try {
        $quickTunnel = Get-Content -LiteralPath $quickTunnelConfig -Raw | ConvertFrom-Json
        $quickUri = [System.Uri]$quickTunnel.url
        if (
            $quickUri.Scheme -ne 'https' `
            -or $quickUri.Host -notmatch '\.trycloudflare\.com$' `
            -or $quickUri.AbsolutePath -ne '/'
        ) {
            throw 'The saved Quick Tunnel URL is invalid.'
        }
        $publicHealth = Invoke-RestMethod -Uri "$($quickUri.AbsoluteUri.TrimEnd('/'))/health/ready" -UseBasicParsing -TimeoutSec 15
        if ($publicHealth.status -eq 'ready') {
            $publicApi = 'online'
            $tunnel = 'online'
            $publicApiUrl = $quickUri.AbsoluteUri.TrimEnd('/')
        }
        else {
            $publicApi = 'offline'
            $tunnel = 'offline'
        }
    }
    catch {
        $publicApi = 'offline'
        $tunnel = 'offline'
    }
}
elseif (Test-Path -LiteralPath (Join-Path $script:RishNovaState 'cloudflared.yml')) {
    $config = Get-Content -LiteralPath (Join-Path $script:RishNovaState 'cloudflared.yml') -Raw
    if ($config -match '(?m)^\s*-\s*hostname:\s*["'']?([A-Za-z0-9.-]+)') {
        try {
            $publicApiUrl = "https://$($Matches[1])"
            $publicHealth = Invoke-RestMethod -Uri "$publicApiUrl/health/ready" -UseBasicParsing -TimeoutSec 15
            if ($publicHealth.status -eq 'ready') {
                $publicApi = 'online'
                $tunnel = 'online'
            }
            else {
                $publicApi = 'offline'
            }
        }
        catch {
            $publicApi = 'offline'
            $tunnel = 'offline'
        }
    }
}

[pscustomobject]@{
    Internet = $internet
    Ollama = $ollama
    Model = $model
    FastAPI = $backend
    Tunnel = $tunnel
    PublicAPI = $publicApi
    PublicAPIUrl = $publicApiUrl
    LastStartupError = $lastError
} | Format-List
