# One-time setup for Chronos on Cloudflare.
# Run from this folder:   powershell -ExecutionPolicy Bypass -File setup.ps1
# Safe to re-run: steps that are already done get skipped.

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
$Name = "chronos"

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ""; Write-Host "Stopped: $text" -ForegroundColor Red; exit 1 }

# 1. Node
Step "Checking Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js isn't installed. Get the LTS version from https://nodejs.org, then run this script again."
}
node --version

# 2. Packages
Step "Installing packages (npm install)"
npm install
if ($LASTEXITCODE -ne 0) { Fail "npm install failed (see above)." }

# 3. Cloudflare login
Step "Checking Cloudflare login"
$who = (npx wrangler whoami 2>&1 | Out-String)
if ($who -match "not authenticated" -or $who -match "You are not logged in") {
  Write-Host "A browser window will open. Sign in to Cloudflare (or create a free account) and click Allow."
  npx wrangler login
  if ($LASTEXITCODE -ne 0) { Fail "Cloudflare login didn't complete." }
} else { Write-Host "Already logged in." }

# 4. D1 database
Step "Setting up the database"
$toml = Get-Content wrangler.toml -Raw
if ($toml -match "PASTE_ID_FROM_wrangler_d1_create") {
  npx wrangler d1 create $Name 2>&1 | Out-Host   # fails harmlessly if it already exists
  $list = (npx wrangler d1 list --json 2>$null | Out-String)
  $db = ($list | ConvertFrom-Json) | Where-Object { $_.name -eq $Name } | Select-Object -First 1
  if (-not $db) { Fail "Couldn't find the '$Name' database after creating it." }
  $toml = $toml -replace "PASTE_ID_FROM_wrangler_d1_create", $db.uuid
  Set-Content -Path wrangler.toml -Value $toml -NoNewline
  Write-Host "Database id saved to wrangler.toml: $($db.uuid)"
} else { Write-Host "Database already configured in wrangler.toml." }

Step "Creating tables"
npx wrangler d1 execute $Name --remote --file schema.sql
if ($LASTEXITCODE -ne 0) { Fail "Creating tables failed (see above)." }

# 5. Deploy (first run may ask you to pick a workers.dev subdomain; answer the prompt)
Step "Deploying"
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { Fail "Deploy failed (see above)." }
$out = (npx wrangler deploy 2>&1 | Out-String)
$m = [regex]::Match($out, "https://[a-zA-Z0-9.-]+\.workers\.dev")
if (-not $m.Success) { Fail "Deployed, but couldn't read the site URL. Check the output above." }
$Url = $m.Value
Write-Host "Your site: $Url" -ForegroundColor Green

# 6. Secrets (written to a temp file and uploaded with "secret bulk", then the file is deleted)
$secrets = (npx wrangler secret list 2>$null | Out-String)
$bulk = @{}
if ($secrets -notmatch "ENC_KEY") {
  $bulk["ENC_KEY"] = (node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")
} else { Write-Host "Encryption key already set (keeping it so nobody gets signed out)." }

if ($secrets -notmatch "NOTION_CLIENT_ID" -or $secrets -notmatch "NOTION_CLIENT_SECRET") {
  Step "Connect Notion"
  Write-Host @"
In your browser, go to https://www.notion.so/profile/integrations and click New integration.
Set the type to Public, then fill in:

  Name             : Chronos
  Company name     : your name
  Website          : $Url
  Privacy policy   : $Url/privacy.html
  Terms of use     : $Url/terms.html
  Support email    : your email
  Redirect URI     : $Url/oauth/callback
  Capabilities     : Read content, Insert content, Read user information including email addresses

Save it, open the Configuration tab, and copy the OAuth client ID and secret.
"@
  Start-Process "https://www.notion.so/profile/integrations"
  do {
    $cid = (Read-Host "Paste the OAuth client ID (looks like 1a2b3c4d-....)").Trim()
    if ($cid -notmatch '^[0-9a-fA-F-]{32,36}$') { Write-Host "That doesn't look like a client ID. It's the short code on the Configuration tab, not a URL." -ForegroundColor Yellow; $cid = $null }
  } while (-not $cid)
  do {
    $sec = Read-Host "Paste the OAuth client secret" -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
  } while (-not $plain)
  $bulk["NOTION_CLIENT_ID"] = $cid
  $bulk["NOTION_CLIENT_SECRET"] = $plain
} else { Write-Host "Notion keys already set." }

if ($bulk.Count -gt 0) {
  Step "Saving secrets to Cloudflare"
  $tmp = Join-Path $env:TEMP ("jd-secrets-" + [guid]::NewGuid() + ".json")
  ($bulk | ConvertTo-Json) | Set-Content -Path $tmp -Encoding ASCII
  npx wrangler secret bulk $tmp
  $ok = $LASTEXITCODE
  Remove-Item $tmp -Force
  $plain = $null; $bulk = $null
  if ($ok -ne 0) { Fail "Saving secrets failed (see above)." }
}
$check = (npx wrangler secret list 2>$null | Out-String)
foreach ($k in "ENC_KEY","NOTION_CLIENT_ID","NOTION_CLIENT_SECRET") {
  if ($check -notmatch $k) { Fail "Secret $k is still missing. Run: npx wrangler secret put $k" }
}

Step "All done"
Write-Host "Open $Url, click Continue with Notion, tick your Goals & Journal page, and pick Journal." -ForegroundColor Green
Start-Process $Url
