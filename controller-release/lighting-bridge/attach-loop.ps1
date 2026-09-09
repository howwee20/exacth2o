$ErrorActionPreference = "Continue"
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$jdkRoot = "C:\Program Files\Java\jdk1.8.0_71"
$jps = Join-Path $jdkRoot "bin\jps.exe"
$java = Join-Path $jdkRoot "bin\java.exe"
$toolsJar = Join-Path $jdkRoot "lib\tools.jar"
$attachJar = Join-Path $bridgeRoot "exacth2o-lighting-attach.jar"
$agentJar = Join-Path $bridgeRoot "exacth2o-lighting-agent-v2.jar"
$properties = Join-Path $bridgeRoot "lighting-agent-v2.properties"
$log = Join-Path $bridgeRoot "attach-loop.log"
$attached = @{}
$lastControllerStart = [DateTime]::MinValue
$controllerPathFile = Join-Path $bridgeRoot "controller-path.txt"
$lastError = ""
$lastErrorAt = [DateTime]::MinValue
$mutex = New-Object Threading.Mutex($false, "Local\ExactH2OLightingWatcher")
if (!$mutex.WaitOne(0, $false)) { exit }

function Write-BridgeLog([string]$message) {
    if ((Test-Path $log) -and (Get-Item $log).Length -ge 1048576) {
        Move-Item $log ($log + ".1") -Force
    }
    ((Get-Date -Format "s") + " " + $message) | Out-File $log -Append -Encoding ascii
}

try {
    Write-BridgeLog "Lighting startup watcher running."
    while (!(Test-Path (Join-Path $bridgeRoot "stop-watcher"))) {
        try {
            # Avoid the automatic $Matches variable and empty PID tokens.
            $processLines = @(& $jps -l 2>&1)
            $seen = @{}
            foreach ($line in $processLines) {
                $parsed = [regex]::Match([string]$line, '^\s*(\d+)\s+(?:PhenoSystemControl\.Main|(?:.*[\\/])?DEPItrol_Mk9000\.jar)\s*$')
                if (!$parsed.Success) { continue }
                $controllerPid = $parsed.Groups[1].Value
                $process = Get-Process -Id ([int]$controllerPid) -ErrorAction Stop
                $identity = $controllerPid + ":" + $process.StartTime.Ticks
                $seen[$identity] = $true
                if ($attached.ContainsKey($identity)) { continue }
                $arguments = @('-cp', ($toolsJar + ';' + $attachJar),
                    'com.exacth2o.lighting.LightingAttach', $controllerPid, $agentJar, $properties)
                $result = & $java @arguments 2>&1 | Out-String
                if ($LASTEXITCODE -ne 0) { throw ("Attach failed for PID " + $controllerPid + ": " + $result.Trim()) }
                $attached[$identity] = $true
                Write-BridgeLog ("Bridge attached to controller PID " + $controllerPid + ".")
            }
            # This file is installed only when automatic controller startup is requested.
            # The existing application initializes its lights to zero on startup.
            if ($seen.Count -eq 0 -and (Test-Path $controllerPathFile) -and
                ((Get-Date) - $lastControllerStart).TotalSeconds -ge 60) {
                $controllerJar = [IO.File]::ReadAllText($controllerPathFile).Trim();
                if (!(Test-Path $controllerJar) -or [IO.Path]::GetFileName($controllerJar) -ne 'DEPItrol_Mk9000.jar') {
                    throw "Configured controller JAR is missing or invalid."
                }
                $lastControllerStart = Get-Date
                $started = Start-Process $java -ArgumentList @('-Xmx3g', '-jar', ('"' + $controllerJar + '"')) `
                    -WorkingDirectory (Split-Path -Parent $controllerJar) -WindowStyle Minimized -PassThru
                Write-BridgeLog ("Started the original lighting controller, PID " + $started.Id + ".")
            }
            foreach ($key in @($attached.Keys)) {
                if (!$seen.ContainsKey($key)) { $attached.Remove($key) }
            }
            $lastError = ""
        } catch {
            $message = $_.Exception.Message
            if ($message -ne $lastError -or ((Get-Date) - $lastErrorAt).TotalSeconds -ge 60) {
                Write-BridgeLog $message
                $lastError = $message
                $lastErrorAt = Get-Date
            }
        }
        Start-Sleep -Seconds 20
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Close()
}
