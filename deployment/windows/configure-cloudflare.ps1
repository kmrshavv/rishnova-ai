param(
    [Parameter(Mandatory = $true)]
    [string]$ApiHostname,
    [switch]$RefreshDnsRoute
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$ApiHostname = $ApiHostname.Trim().TrimEnd('.').ToLowerInvariant()
if (
    [System.Uri]::CheckHostName($ApiHostname) -ne [System.UriHostNameType]::Dns `
    -or $ApiHostname -notmatch '\.' `
    -or $ApiHostname -match '[*:/@?#]' `
    -or $ApiHostname.EndsWith('.pages.dev') `
    -or $ApiHostname.EndsWith('.trycloudflare.com')
) {
    throw 'Supply a DNS hostname in a Cloudflare zone you control, such as api.example.com. Do not use a Pages or Quick Tunnel hostname.'
}

$cloudflared = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
if ($cloudflared) {
    $cloudflaredPath = $cloudflared.Source
}
else {
    $knownPaths = @(
        (Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'),
        (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe')
    )
    $cloudflaredPath = $knownPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $cloudflaredPath) {
        throw 'cloudflared.exe was not found. Install Cloudflare Tunnel before configuring it.'
    }
}

$certificate = Join-Path $env:USERPROFILE '.cloudflared\cert.pem'
if (-not (Test-Path -LiteralPath $certificate)) {
    Write-Output 'Cloudflare account login is required; complete the browser authorization prompt.'
    & $cloudflaredPath tunnel login
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $certificate)) {
        throw 'Cloudflare Tunnel login did not complete successfully.'
    }
}

function Get-RishNovaTunnels {
    $output = & $cloudflaredPath tunnel list --output json 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Could not list named Cloudflare Tunnels: $($output -join ' ')"
    }
    try {
        return @($output -join "`n" | ConvertFrom-Json)
    }
    catch {
        throw 'Cloudflare Tunnel returned an unreadable tunnel list.'
    }
}

$tunnel = Get-RishNovaTunnels | Where-Object { $_.name -eq 'rishnova-ai' } | Select-Object -First 1
if (-not $tunnel) {
    $output = & $cloudflaredPath tunnel create rishnova-ai 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the named RishNova tunnel: $($output -join ' ')"
    }
    $tunnel = Get-RishNovaTunnels | Where-Object { $_.name -eq 'rishnova-ai' } | Select-Object -First 1
}
if (-not $tunnel -or $tunnel.id -notmatch '^[0-9a-fA-F-]{36}$') {
    throw 'The named RishNova tunnel does not have a valid tunnel ID.'
}

$credentials = Join-Path (Join-Path $env:USERPROFILE '.cloudflared') "$($tunnel.id).json"
if (-not (Test-Path -LiteralPath $credentials)) {
    throw "Tunnel credentials were not found at $credentials. Do not copy credentials into the repository."
}

New-Item -ItemType Directory -Path $script:RishNovaState -Force | Out-Null
$configPath = Join-Path $script:RishNovaState 'cloudflared.yml'
$yamlCredentials = $credentials.Replace("'", "''")
$config = @"
tunnel: $($tunnel.id)
credentials-file: '$yamlCredentials'
ingress:
  - hostname: $ApiHostname
    service: http://127.0.0.1:8000
  - service: http_status:404
"@
[System.IO.File]::WriteAllText($configPath, $config, [System.Text.UTF8Encoding]::new($false))

$validation = & $cloudflaredPath tunnel --config $configPath ingress validate 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare Tunnel rejected the generated configuration: $($validation -join ' ')"
}

$routeMarkerPath = Join-Path $script:RishNovaState 'cloudflared-route.json'
$routeIsConfigured = $false
if (Test-Path -LiteralPath $routeMarkerPath) {
    try {
        $routeMarker = Get-Content -LiteralPath $routeMarkerPath -Raw | ConvertFrom-Json
        $routeIsConfigured = $routeMarker.tunnel_id -eq $tunnel.id -and $routeMarker.hostname -eq $ApiHostname
    }
    catch {
        $routeIsConfigured = $false
    }
}
if ($RefreshDnsRoute -or -not $routeIsConfigured) {
    $routeOutput = & $cloudflaredPath tunnel route dns $tunnel.id $ApiHostname 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the DNS route for $ApiHostname. Check Cloudflare DNS for an existing conflicting record: $($routeOutput -join ' ')"
    }
    $routeMarker = @{
        tunnel_id = $tunnel.id
        hostname = $ApiHostname
        configured_at = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText($routeMarkerPath, $routeMarker, [System.Text.UTF8Encoding]::new($false))
}

try {
    Invoke-RishNovaControl -Path '/start' -Method POST | Out-Null
}
catch {
    if (Get-RishNovaControlInfo) {
        throw
    }
}

Write-Output "Configured the stable named tunnel for https://$ApiHostname."
Write-Output "In Cloudflare Pages, set BACKEND_API_URL=https://$ApiHostname and redeploy the site."
Write-Output 'The tunnel forwards only to FastAPI on 127.0.0.1:8000; Ollama remains private.'
