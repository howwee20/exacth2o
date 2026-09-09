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

Version 2.1.1 allows 20 seconds for cloud responses, polls every two seconds
after successful work, and backs off up to 30 seconds with jitter during an
outage. It keeps only the newest snapshot and preserves acknowledgement retries.
Commands that expire during network delivery are rejected before model access.

Cloud failures and recovery are recorded outside the instrument display in
`~/.local/state/exacth2o-gas-mixer-native-bridge/cloud.log` (256 KiB plus two
rotations). Repeated failures are summarized at most once per minute, without
tokens, state payloads, or response bodies. Logging failure cannot print into
the mixer display. The existing local gas/MFC error reporting is unchanged.

Run the hardware-free failure tests with:
`python3 -m unittest discover -s controller-release/gas-mixer-native-bridge -p 'test_*.py'`.


### Version 2.1.2 acknowledgement correction

The bridge reports `applied` after invoking the existing Qt model. It does not report `verified`: model setters and cached delivered values cannot establish fresh physical flow or serial-write success. The portal treats `applied` as a software receipt and explicitly states that physical flow remains unverified. Instrument feedback timestamps, settling tolerances, and retained per-command evidence are required before physical verification can be implemented. No MFC addresses, calibration, balance behavior, or serial ownership change in this release.
