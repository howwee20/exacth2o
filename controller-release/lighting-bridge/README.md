# ExactH2O BEAGLE lighting bridge

This additive Java agent attaches to the already-running legacy controller and
uses its public `Control.getIntensity`, `Control.setIntensity`, and
`Control.update` methods. It does not edit the NetBeans project, open the FPGA,
start the chamber application, or replace local/timeline control.

V2 also mirrors authoritative controller changes into the open legacy
`MaintenanceGUI` checkbox, slider, and intensity field on Swing's event thread.
It does not press Execute or issue a duplicate hardware command. Local changes
continue through the original GUI and are observed through `Control.getIntensity`.

The watcher is installed separately under `C:\ProgramData\ExactH2O\LightingBridge`
and can be stopped by ending its PowerShell process or setting `enabled=false`
in `lighting-agent-v2.properties`. Portal commands remain fail-closed unless
`bridge_ready=true` and the heartbeat is fresh.

`build.ps1` compiles against the JDK already installed on BEAGLE. `install.ps1`
installs the additive watcher without restarting the controller and defaults to
commissioning mode. `commission.ps1` enables portal commands only after the
bridge heartbeat and controller state are checked. `rollback.ps1` stops the
watcher and removes its scheduled launch while leaving the controller and all
bridge files intact.

`upgrade-v2.ps1` performs an in-place hot upgrade from the commissioned V1
bridge. The versioned Agent-Class permits attachment to the already-running JVM;
the old configuration is disabled and retained for rollback.
