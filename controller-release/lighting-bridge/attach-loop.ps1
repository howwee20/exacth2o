$ErrorActionPreference = "Continue"
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$jdkRoot = "C:\Program Files\Java\jdk1.8.0_71"
$jps = Join-Path $jdkRoot "bin\jps.exe"
$java = Join-Path $jdkRoot "bin\java.exe"
$tools = Join-Path $jdkRoot "lib\tools.jar"
$attachJar = Join-Path $bridgeRoot "exacth2o-lighting-attach.jar"
$agentJar = Join-Path $bridgeRoot "exacth2o-lighting-agent.jar"
$properties = Join-Path $bridgeRoot "lighting-agent.properties"
$log = Join-Path $bridgeRoot "attach-loop.log"

while ($true) {
    try {
        $matches = & $jps -l 2>&1 | Select-String "PhenoSystemControl.Main"
        foreach ($match in $matches) {
            $pid = ($match.Line -split "\s+")[0]
            & $java -cp "$tools;$attachJar" com.exacth2o.lighting.LightingAttach $pid $agentJar $properties 2>&1 |
                Out-File -FilePath $log -Append -Encoding ascii
        }
    } catch {
        $_ | Out-File -FilePath $log -Append -Encoding ascii
    }
    Start-Sleep -Seconds 20
}
