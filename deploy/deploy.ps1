<#
  Deploy the Raidar Discord bot to the Oracle VM over SSH.

  Usage (from discord-bot/):
    pwsh deploy/deploy.ps1 -KeyPath "C:\Users\jirik\Downloads\ssh-key-2026-06-20.key"

  Prereqs on the VM: handled automatically below (Node 20 via NodeSource on
  Ubuntu). Requires passwordless sudo for the opc user.

  The pairing web page needs ONE inbound port open (PAIRING_PORT, default 3000):
    # Oracle Cloud console: add an ingress rule to the subnet's security list/NSG
    sudo ufw allow 3000/tcp        # if ufw is enabled
  All other traffic (Discord, Rust+, FCM) is outbound only.
#>
param(
  [Parameter(Mandatory = $true)][string]$KeyPath,
  [string]$Remote = "opc@92.5.73.207",
  [string]$RemoteDir = "/home/opc/raidar-bot"
)

$ErrorActionPreference = "Stop"
$BotDir = Split-Path -Parent $PSScriptRoot   # discord-bot/
$Tarball = Join-Path $env:TEMP "raidar-bot.tar.gz"

Write-Host "==> Packaging bot (excluding node_modules)..." -ForegroundColor Cyan
# tar ships with Windows 10+. Include code + env + tenant state, skip deps/git.
$items = @("package.json", "src", "scripts", "deploy", ".env", ".env.example")
if (Test-Path (Join-Path $BotDir "data")) { $items += "data" }
tar --exclude="node_modules" --exclude=".git" -czf $Tarball -C $BotDir $items 2>$null
if (-not (Test-Path $Tarball)) { throw "Failed to create tarball." }

Write-Host "==> Copying to $Remote ..." -ForegroundColor Cyan
ssh -i $KeyPath -o StrictHostKeyChecking=accept-new $Remote "mkdir -p $RemoteDir"
scp -i $KeyPath $Tarball "${Remote}:${RemoteDir}/raidar-bot.tar.gz"

Write-Host "==> Installing & starting on the VM ..." -ForegroundColor Cyan
$remoteScript = @"
set -e
cd $RemoteDir
tar -xzf raidar-bot.tar.gz && rm -f raidar-bot.tar.gz
sed -i 's/\r$//' deploy/provision.sh
bash deploy/provision.sh
export PATH=`$PATH:/usr/local/bin
npm install --omit=dev
node scripts/patch-proto.cjs || true
node src/deploy-commands.js || echo 'WARN: command registration skipped (set DISCORD_CLIENT_ID in .env), continuing'
sudo cp deploy/raidar-bot.service /etc/systemd/system/raidar-bot.service
sudo systemctl daemon-reload
sudo systemctl enable raidar-bot
sudo systemctl restart raidar-bot
sleep 2
sudo systemctl --no-pager status raidar-bot | head -n 14
"@ -replace "`r`n", "`n"
ssh -i $KeyPath $Remote $remoteScript

Remove-Item $Tarball -ErrorAction SilentlyContinue
Write-Host "==> Done. Tail logs with:" -ForegroundColor Green
Write-Host "    ssh -i `"$KeyPath`" $Remote 'journalctl -u raidar-bot -f'"
