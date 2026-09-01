# ExactH2O Gas Mixer Native Bridge

This is the commissioning package for the native V2 form. It is separate from
and does not replace the existing screen-capture/tap agent.

The bridge is loaded inside the existing `pi-mfc-gui.py` process and receives a
reference to the live `PiMfcGuiModel`. It therefore:

- never opens `/dev/ttyUSB0` or creates a second Alicat controller;
- sends structured requested/applied/observed state over outbound HTTPS;
- applies only the configured LI-COR, total-flow, ratio, and setpoint fields;
- isolates outbound HTTPS in a coalescing standard Python worker so a slow
  network cannot build an unbounded Qt event backlog or crash the mixer UI;
- rejects balance-MFC writes, unavailable channels, stale revisions, unknown
  fields, shell input, GPIO input, and arbitrary payloads; and
- leaves the physical touchscreen and V1 live-screen agent in place.

`install-native-bridge.sh` stages the module and an additive two-line entrypoint
hook, preserves the original exact rollback copy, validates Python syntax, and
does not restart the running mixer. The supervised no-gas commissioning reboot
is the only point at which the staged bridge becomes active.
