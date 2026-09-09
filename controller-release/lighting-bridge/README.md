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

## Windows recovery release 2.1.0 (2026-09-09)

The bridge retains the original Control API and maintenance-screen synchronization.
Cloud failures retry with delays capped at 20 seconds, repeated identical errors log
at most once per minute, and logs rotate at 1 MiB with three archives. Successful
requests restore the normal polling cadence. HTTP connections close on failure too.
Run `tests\run.ps1` on the Windows JDK to verify retry and retention behavior.

The startup watcher parses complete JVM identities, recognizes both NetBeans
`PhenoSystemControl.Main` and the packaged `DEPItrol_Mk9000.jar`, and attaches once
per process lifetime. A named mutex prevents duplicate watchers. The optional
`controller-path.txt` in the installed bridge directory contains the absolute path
to the existing controller JAR. When present, the watcher also starts that original
application if absent, with its existing working directory and 3 GiB heap, at most
once per minute. The original controller initializes lights to zero after a restart;
the bridge does not restore an old light command automatically. Delete that optional
path file to retain attachment-only operation. Create `stop-watcher` to stop supervision.

On BEAGLE, the enabled `ExactH2O Lighting Bridge` task runs as Eric at sign-in.
Windows automatic sign-in is disabled: after a PC reboot, sign in to Eric once.
The controller and bridge then start without opening NetBeans. The desktop shortcut
`ExactH2O Lighting Controller` starts supervision if it was stopped. This setup needs
an internet-connected Ethernet uplink; the Mac is needed only during maintenance.
The two existing instrument adapters at 10.0.1.1 and 10.0.2.1 remain unchanged.
