$ErrorActionPreference = 'Stop'
$base = 'http://localhost:8080'
Write-Host "Using base: $base"

# Helper to POST JSON and return parsed object
function Post-Json($uri, $obj) {
  $json = $obj | ConvertTo-Json -Depth 10
  return Invoke-RestMethod -Uri $uri -Method Post -ContentType 'application/json' -Body $json
}

try {
  Write-Host "Registering sender..."
  $sender = Post-Json "$base/auth/register" @{ userId = 'test_sender'; userName = 'Test Sender'; email = 'sender@example.com'; password = 'password' }
  Write-Host "Sender registered: " ($sender | ConvertTo-Json -Depth 3)

  Write-Host "Registering recipient..."
  $recipient = Post-Json "$base/auth/register" @{ userId = 'test_recipient'; userName = 'Test Recipient'; email = 'recipient@example.com'; password = 'password' }
  Write-Host "Recipient registered: " ($recipient | ConvertTo-Json -Depth 3)

  Write-Host "Sending friend request (sender -> recipient)..."
  $add = Post-Json "$base/friends/add" @{ userId = 'test_sender'; friendId = 'test_recipient' }
  Write-Host "Friend request response:" ($add | ConvertTo-Json -Depth 4)
  $requestId = $add.requestId
  if (-not $requestId) { throw "No requestId returned" }

  Write-Host "Accepting friend request as recipient..."
  $accept = Post-Json "$base/friends/request/$requestId/accept" @{ userId = 'test_recipient' }
  Write-Host "Accept response:" ($accept | ConvertTo-Json -Depth 6)

  Write-Host "Dev store snapshot (dev_dynamo_users.json):"
  $devPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'dev_dynamo_users.json'
  if (Test-Path $devPath) {
    Get-Content $devPath | Out-String | Write-Host
  } else {
    Write-Host "Dev store not found at $devPath"
  }
} catch {
  Write-Error "Smoke test failed: $_"
  exit 2
}

Write-Host "Smoke test completed successfully"; exit 0
