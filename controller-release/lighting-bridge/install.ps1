param(
    [Parameter(Mandatory = $true)]
    [string]$DeviceToken,
    [switch]$Commission
)

$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = "C:\ProgramData\ExactH2O\LightingBridge"
$taskName = "ExactH2O Lighting Bridge"

if (-not (Test-Path (Join-Path $source "exacth2o-lighting-agent.jar"))) {
    throw "Build exacth2o-lighting-agent.jar before installation"
}
if ($DeviceToken.Length -lt 32) { throw "A valid device token is required" }

New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item (Join-Path $source "exacth2o-lighting-agent.jar") $target -Force
Copy-Item (Join-Path $source "exacth2o-lighting-attach.jar") $target -Force
Copy-Item (Join-Path $source "attach-loop.ps1") $target -Force
Copy-Item (Join-Path $source "start-hidden.vbs") $target -Force

$properties = @(
    "endpoint=https://zmhdclcjrkntrpynozvo.supabase.co/functions/v1/lighting-native-agent",
    "device_token=$DeviceToken",
    "enabled=true",
    "bridge_ready=$($Commission.IsPresent.ToString().ToLowerInvariant())",
    "poll_ms=1000",
    "log_path=C:\ProgramData\ExactH2O\LightingBridge\lighting-agent.log"
)
$properties | Out-File (Join-Path $target "lighting-agent.properties") -Encoding ascii -Force

schtasks.exe /Create /TN $taskName /TR "wscript.exe `"$target\start-hidden.vbs`"" /SC ONLOGON /RL HIGHEST /F | Out-Null
Start-Process "wscript.exe" -ArgumentList "`"$target\start-hidden.vbs`"" -WindowStyle Hidden

Write-Output "ExactH2O lighting bridge installed without changing or restarting the legacy controller."
