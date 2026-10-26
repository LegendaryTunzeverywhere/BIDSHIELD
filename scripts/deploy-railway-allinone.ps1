#requires -Version 5.1
<#
.SYNOPSIS
  Create the single-service Bidshield stack in the Railway account the CLI is
  currently logged into.

.DESCRIPTION
  This does not touch the existing five-service project. It creates a new
  project, one service, one /data volume, sets the all-in-one build settings
  and variables, generates a public domain, and deploys from the local repo.

  Run without -Apply first to print the exact commands. Then run with -Apply.

.PARAMETER AuctioneerMnemonic
  Escrow wallet BIP-39 phrase. If omitted, ZECD_MNEMONIC is read from .env.

.PARAMETER Force
  If this directory is linked to a different Railway project, unlink it before
  creating the new project. This only changes the local CLI link.

.EXAMPLE
  .\scripts\deploy-railway-allinone.ps1 -Apply
#>
[CmdletBinding()]
param(
  [string]$ProjectName = 'bidshield',
  [string]$ServiceName = 'bidshield',
  [string]$VercelOrigin = 'https://bidshield-demo.vercel.app',
  [string]$FunderMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
  [string]$AuctioneerMnemonic = '',
  [switch]$Force,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Write-Step([string]$Text) {
  Write-Host "`n== $Text" -ForegroundColor Cyan
}

function Format-Arg([string]$Value) {
  if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
  return $Value
}

function Show-Railway([string[]]$Arguments) {
  Write-Host ('  railway ' + (($Arguments | ForEach-Object { Format-Arg $_ }) -join ' '))
}

function Invoke-Railway([string[]]$Arguments, [switch]$AllowFail) {
  & railway @Arguments
  if ($LASTEXITCODE -ne 0 -and -not $AllowFail) {
    throw "railway $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

try {
  if (-not (Get-Command railway -ErrorAction SilentlyContinue)) {
    throw 'Railway CLI not found. Install it from https://docs.railway.com/guides/cli'
  }

  if (-not $AuctioneerMnemonic) {
    $envFile = Join-Path $root '.env'
    if (Test-Path -LiteralPath $envFile) {
      $line = Get-Content -LiteralPath $envFile |
        Where-Object { $_ -match '^\s*ZECD_MNEMONIC\s*=' } |
        Select-Object -First 1
      if ($line) {
        $AuctioneerMnemonic = ($line -replace '^\s*ZECD_MNEMONIC\s*=\s*', '').Trim().Trim('"').Trim("'")
      }
    }
  }
  if (-not $AuctioneerMnemonic) {
    throw 'No auctioneer mnemonic. Set ZECD_MNEMONIC in .env or pass -AuctioneerMnemonic "<12/24 words>".'
  }

  $vars = @(
    "CORS_ORIGIN=$VercelOrigin",
    'COOKIE_SECURE=1',
    'TRUST_PROXY=1',
    'IDLE_STOP_SECS=900',
    'MINER_INTERVAL_SECS=1',
    'FUNDER_TARGET_ZATS=10000000000',
    'TOPUP_BLOCKS=120',
    'WARM_ON_BOOT=0',
    'RUST_LOG=info,tower_http=warn',
    'RAILWAY_DOCKERFILE_PATH=docker/railway/allinone.Dockerfile'
  )

  $configCommand = @(
    'environment', 'edit',
    '--service-config', $ServiceName, 'build.builder', 'DOCKERFILE',
    '--service-config', $ServiceName, 'build.dockerfilePath', 'docker/railway/allinone.Dockerfile',
    '--service-config', $ServiceName, 'deploy.healthcheckPath', '/__gateway/health',
    '--service-config', $ServiceName, 'deploy.healthcheckTimeout', '120',
    '--service-config', $ServiceName, 'deploy.restartPolicyType', 'ALWAYS',
    '--message', 'Configure all-in-one Bidshield service'
  )

  Write-Step "Target"
  Write-Host "  project:  $ProjectName"
  Write-Host "  service:  $ServiceName"
  Write-Host "  origin:   $VercelOrigin"
  Write-Host "  volume:   /data"
  Write-Host "  seeds:    funder=$(if ($FunderMnemonic) { 'set' } else { 'missing' }), auctioneer=$(if ($AuctioneerMnemonic) { 'set' } else { 'missing' })"
  Write-Host '  NOTE: the default seeds are public regtest test vectors. Never use them for real funds.' -ForegroundColor Yellow

  if (-not $Apply) {
    Write-Step "Commands (dry run)"
    Show-Railway @('whoami')
    Show-Railway @('status', '--json')
    Show-Railway @('init', '--name', $ProjectName)
    Show-Railway @('add', '--service', $ServiceName)
    Show-Railway @('service', 'link', $ServiceName)
    Show-Railway $configCommand
    Show-Railway (@('variable', 'set', '--service', $ServiceName, '--skip-deploys') + $vars)
    Write-Host '  (auctioneer/funder mnemonics are sent separately over stdin)'
    Show-Railway @('volume', 'add', '--service', $ServiceName, '--mount-path', '/data', '--json')
    Show-Railway @('domain', '--service', $ServiceName, '--port', '8080', '--json')
    Show-Railway @('up', '--service', $ServiceName, '--ci', '-y')
    Write-Host "`nDry run only. Re-run with -Apply to execute." -ForegroundColor Green
    return
  }

  Write-Step 'Checking Railway login'
  Invoke-Railway @('whoami')

  $status = $null
  $statusRaw = & railway status --json 2>$null
  if ($LASTEXITCODE -eq 0 -and $statusRaw) {
    $status = $statusRaw | ConvertFrom-Json
  }

  if ($status -and $status.name -and $status.name -ne $ProjectName) {
    if (-not $Force) {
      throw "This directory is linked to '$($status.name)'. Run 'railway unlink', or pass -Force to unlink and create '$ProjectName'."
    }
    Write-Step "Unlinking $($status.name)"
    Invoke-Railway @('unlink', '--yes')
    $status = $null
  }

  if (-not $status) {
    Write-Step "Creating project $ProjectName"
    Invoke-Railway @('init', '--name', $ProjectName)
  } else {
    Write-Step "Using linked project $($status.name)"
  }

  Write-Step "Creating service $ServiceName"
  Invoke-Railway @('add', '--service', $ServiceName) -AllowFail
  Invoke-Railway @('service', 'link', $ServiceName)

  Write-Step 'Setting build and deploy config'
  Invoke-Railway $configCommand

  Write-Step 'Setting non-secret variables'
  Invoke-Railway (@('variable', 'set', '--service', $ServiceName, '--skip-deploys') + $vars)

  Write-Step 'Setting wallet seeds over stdin'
  $FunderMnemonic.Trim() | & railway variable set FUNDER_MNEMONIC --stdin --service $ServiceName --skip-deploys
  if ($LASTEXITCODE -ne 0) { throw 'Failed to set FUNDER_MNEMONIC' }
  $AuctioneerMnemonic.Trim() | & railway variable set AUCTIONEER_MNEMONIC --stdin --service $ServiceName --skip-deploys
  if ($LASTEXITCODE -ne 0) { throw 'Failed to set AUCTIONEER_MNEMONIC' }

  Write-Step 'Ensuring /data volume'
  $hasDataVolume = $false
  $volumeRaw = & railway volume list --json 2>$null
  if ($LASTEXITCODE -eq 0 -and $volumeRaw) {
    $volumeList = $volumeRaw | ConvertFrom-Json
    $hasDataVolume = @($volumeList.volumes | Where-Object {
      $_.serviceName -eq $ServiceName -and $_.mountPath -eq '/data'
    }).Count -gt 0
  }
  if (-not $hasDataVolume) {
    Invoke-Railway @('volume', 'add', '--service', $ServiceName, '--mount-path', '/data', '--json')
  } else {
    Write-Host '  /data volume already attached'
  }

  Write-Step 'Generating public domain on port 8080'
  $domain = $null
  $domainRaw = & railway domain --service $ServiceName --port 8080 --json 2>$null
  if ($LASTEXITCODE -eq 0 -and $domainRaw) {
    try {
      $d = $domainRaw | ConvertFrom-Json
      $domain = $d.domain
      if (-not $domain) { $domain = $d.hostname }
      if (-not $domain -and $d.domains) { $domain = $d.domains[0].domain }
    } catch {
      Write-Host "  Domain command returned: $domainRaw"
    }
  }
  if (-not $domain) {
    # The create command sometimes only echoes; read the list to confirm.
    $listRaw = & railway domain list --service $ServiceName --json 2>$null
    if ($LASTEXITCODE -eq 0 -and $listRaw) {
      try {
        $domain = ($listRaw | ConvertFrom-Json).domains[0].domain
      } catch { }
    }
  }
  if (-not $domain) {
    Write-Host '  Could not parse the generated domain. Run: railway domain list --service bidshield --json' -ForegroundColor Yellow
  }

  Write-Step 'Deploying from the local repository'
  Invoke-Railway @('up', '--service', $ServiceName, '--ci', '-y')

  Write-Step 'Done'
  if ($domain) {
    Write-Host "  Backend: https://$domain" -ForegroundColor Green
    Write-Host '  Update web/vercel.json:'
    Write-Host "    `"destination`": `"https://$domain/api/:path*`""
  } else {
    Write-Host '  Get the domain with: railway domain list --service bidshield --json'
  }
  Write-Host "  Logs:   railway logs --service $ServiceName"
  Write-Host "  Status: https://<domain>/__gateway/status"
  Write-Host '  First request starts the chain and may take a couple of minutes.' -ForegroundColor Yellow
} finally {
  Pop-Location
}
