$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$jdk = "C:\Program Files\Java\jdk1.8.0_71"
$classes = Join-Path $root "classes"

New-Item -ItemType Directory -Path $classes -Force | Out-Null
& (Join-Path $jdk "bin\javac.exe") `
    -source 1.7 `
    -target 1.7 `
    -cp (Join-Path $jdk "lib\tools.jar") `
    -d $classes `
    (Join-Path $root "src\com\exacth2o\lighting\LightingAgent.java") `
    (Join-Path $root "src\com\exacth2o\lighting\LightingAttach.java")
if ($LASTEXITCODE -ne 0) { throw "Lighting bridge compilation failed" }

& (Join-Path $jdk "bin\jar.exe") cfm `
    (Join-Path $root "exacth2o-lighting-agent.jar") `
    (Join-Path $root "agent-manifest.mf") `
    -C $classes com
if ($LASTEXITCODE -ne 0) { throw "Lighting agent packaging failed" }

& (Join-Path $jdk "bin\jar.exe") cfm `
    (Join-Path $root "exacth2o-lighting-attach.jar") `
    (Join-Path $root "attach-manifest.mf") `
    -C $classes com
if ($LASTEXITCODE -ne 0) { throw "Lighting attach packaging failed" }

Get-FileHash (Join-Path $root "exacth2o-lighting-agent.jar") -Algorithm SHA256
Get-FileHash (Join-Path $root "exacth2o-lighting-attach.jar") -Algorithm SHA256
