# ExactH2O BEAGLE lighting bridge

This additive Java agent attaches to the already-running legacy controller and
uses its public `Control.getIntensity`, `Control.setIntensity`, and
`Control.update` methods. It does not edit the NetBeans project, open the FPGA,
start the chamber application, or replace local/timeline control.

The watcher is installed separately under `C:\ProgramData\ExactH2O\LightingBridge`
and can be stopped by ending its PowerShell process or setting `enabled=false`
in `lighting-agent.properties`. Portal commands remain fail-closed unless
`bridge_ready=true` and the heartbeat is fresh.

`build.ps1` compiles against the JDK already installed on BEAGLE. `install.ps1`
installs the additive watcher without restarting the controller and defaults to
commissioning mode. `commission.ps1` enables portal commands only after the
bridge heartbeat and controller state are checked. `rollback.ps1` stops the
watcher and removes its scheduled launch while leaving the controller and all
bridge files intact.
