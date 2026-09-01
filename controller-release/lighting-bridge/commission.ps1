$ErrorActionPreference = "Stop"
$propertiesPath = "C:\ProgramData\ExactH2O\LightingBridge\lighting-agent-v2.properties"
if (-not (Test-Path $propertiesPath)) { throw "Lighting bridge is not installed" }

$content = Get-Content $propertiesPath
$content = $content | ForEach-Object {
    if ($_ -match '^bridge_ready=') { 'bridge_ready=true' } else { $_ }
}
$content | Out-File $propertiesPath -Encoding ascii -Force
Write-Output "ExactH2O lighting bridge commissioned."
