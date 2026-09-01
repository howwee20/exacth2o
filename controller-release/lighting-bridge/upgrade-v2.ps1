$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = "C:\ProgramData\ExactH2O\LightingBridge"
$taskName = "ExactH2O Lighting Bridge"
$legacyProperties = Join-Path $target "lighting-agent.properties"
$v2Properties = Join-Path $target "lighting-agent-v2.properties"
$jdk = "C:\Program Files\Java\jdk1.8.0_71"

if (-not (Test-Path $legacyProperties)) { throw "The installed lighting bridge configuration was not found" }
if (-not (Test-Path (Join-Path $source "exacth2o-lighting-agent-v2.jar"))) { throw "The V2 agent JAR was not found" }
if (-not (Test-Path (Join-Path $source "exacth2o-lighting-attach.jar"))) { throw "The attach JAR was not found" }

$deviceTokenLine = Get-Content $legacyProperties | Where-Object { $_ -match '^device_token=' } | Select-Object -First 1
if (-not $deviceTokenLine) { throw "The installed device credential was not found" }

Copy-Item (Join-Path $source "exacth2o-lighting-agent-v2.jar") $target -Force
Copy-Item (Join-Path $source "exacth2o-lighting-attach.jar") $target -Force
Copy-Item (Join-Path $source "attach-loop.ps1") $target -Force
Copy-Item (Join-Path $source "start-hidden.vbs") $target -Force

@(
    "endpoint=https://zmhdclcjrkntrpynozvo.supabase.co/functions/v1/lighting-native-agent",
    $deviceTokenLine,
    "enabled=true",
    "bridge_ready=true",
    "poll_ms=1000",
    "log_path=C:/ProgramData/ExactH2O/LightingBridge/lighting-agent-v2.log"
) | Out-File $v2Properties -Encoding ascii -Force

$legacyContent = Get-Content $legacyProperties | ForEach-Object {
    if ($_ -match '^enabled=') { 'enabled=false' } else { $_ }
}
$legacyContent | Out-File $legacyProperties -Encoding ascii -Force

Get-WmiObject Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
    $_.CommandLine -like '*ExactH2O*LightingBridge*attach-loop.ps1*'
} | ForEach-Object { $_.Terminate() | Out-Null }

$jps = Join-Path $jdk "bin\jps.exe"
$java = Join-Path $jdk "bin\java.exe"
$tools = Join-Path $jdk "lib\tools.jar"
$attachJar = Join-Path $target "exacth2o-lighting-attach.jar"
$agentJar = Join-Path $target "exacth2o-lighting-agent-v2.jar"

$controllers = & $jps -l 2>&1 | Select-String "PhenoSystemControl.Main"
if (-not $controllers) { throw "The existing PhenoSystemControl controller process was not found" }
foreach ($controller in $controllers) {
    $controllerPid = ($controller.Line -split "\s+")[0]
    & $java -cp "$tools;$attachJar" com.exacth2o.lighting.LightingAttach $controllerPid $agentJar $v2Properties
    if ($LASTEXITCODE -ne 0) { throw "Unable to attach the V2 lighting bridge" }
}

schtasks.exe /Create /TN $taskName /TR "wscript.exe `"$target\start-hidden.vbs`"" /SC ONLOGON /RL HIGHEST /F | Out-Null
Start-Process "wscript.exe" -ArgumentList "`"$target\start-hidden.vbs`"" -WindowStyle Hidden

Write-Output "ExactH2O lighting bridge V2 installed and attached without restarting the legacy controller."
