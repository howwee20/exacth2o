$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$jdk = "C:\Program Files\Java\jdk1.8.0_71"
$classes = Join-Path $root "classes"

New-Item -ItemType Directory -Path $classes -Force | Out-Null
& (Join-Path $jdk "bin\javac.exe") `
    -source 1.7 `
    -target 1.7 `
    -cp (Join-Path $jdk "lib\tools.jar") `
    -d $classes `
    (Join-Path $root "src\com\exacth2o\lighting\LightingAgentV2.java") `
    (Join-Path $root "src\com\exacth2o\lighting\LightingAttach.java")
if ($LASTEXITCODE -ne 0) { throw "Lighting bridge compilation failed" }

& (Join-Path $jdk "bin\jar.exe") cfm `
    (Join-Path $root "exacth2o-lighting-agent-v2.jar") `
    (Join-Path $root "agent-v2-manifest.mf") `
    -C $classes com
if ($LASTEXITCODE -ne 0) { throw "Lighting agent packaging failed" }

& (Join-Path $jdk "bin\jar.exe") cfm `
    (Join-Path $root "exacth2o-lighting-attach.jar") `
    (Join-Path $root "attach-manifest.mf") `
    -C $classes com
if ($LASTEXITCODE -ne 0) { throw "Lighting attach packaging failed" }

& certutil.exe -hashfile (Join-Path $root "exacth2o-lighting-agent-v2.jar") SHA256
& certutil.exe -hashfile (Join-Path $root "exacth2o-lighting-attach.jar") SHA256
