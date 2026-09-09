$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$jdk = 'C:\Program Files\Java\jdk1.8.0_71'
$classes = Join-Path $root 'test-classes'
New-Item -ItemType Directory -Path $classes -Force | Out-Null
& ($jdk + '\bin\javac.exe') -source 1.7 -target 1.7 -d $classes `
    (Join-Path $root 'src\com\exacth2o\lighting\LightingAgentV2.java') `
    (Join-Path $root 'tests\LightingReliabilityTest.java')
if ($LASTEXITCODE -ne 0) { throw 'Test compilation failed' }
& ($jdk + '\bin\java.exe') -cp $classes com.exacth2o.lighting.LightingReliabilityTest $classes
if ($LASTEXITCODE -ne 0) { throw 'Lighting reliability tests failed' }
