$ErrorActionPreference = "Continue"
$target = "C:\ProgramData\ExactH2O\LightingBridge"
$taskName = "ExactH2O Lighting Bridge"
$propertiesPath = Join-Path $target "lighting-agent.properties"

if (Test-Path $propertiesPath) {
    $content = Get-Content $propertiesPath | ForEach-Object {
        if ($_ -match '^enabled=') { 'enabled=false' } else { $_ }
    }
    $content | Out-File $propertiesPath -Encoding ascii -Force
}

schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null
Get-WmiObject Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
    $_.CommandLine -like '*ExactH2O*LightingBridge*attach-loop.ps1*'
} | ForEach-Object { $_.Terminate() | Out-Null }

Write-Output "ExactH2O lighting bridge stopped. The legacy controller and bridge files were preserved."
