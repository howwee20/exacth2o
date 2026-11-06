# Controller scheduler

`src/index.ts` starts the scheduler. `src/StateMachine.ts` coordinates startup,
sensor measurements, rule evaluation, queued transitions and valve admission.
The HTTP interface is in `src/Server.ts`.

| Question | Start here |
| --- | --- |
| How are pairings loaded and tracked? | `src/services/PairingService.ts` |
| When may automatic watering run? | `src/services/WateringSafety.ts` and `src/StateMachine.ts` |
| Who owns the valve supply? | `src/services/ValveArbiter.ts` |
| How do holds expire? | `src/services/ManualHoldManager.ts` |
| How do timed pulses recover after restart? | `src/services/ManualPulseManager.ts` and `src/services/WateringPulseLedger.ts` |
| Where are queued transitions handled? | `src/services/BullQueueService.ts` |
| How are hardware calls made? | `src/services/ValveService.ts` and `src/services/SensorService.ts` |

Run `npm ci --ignore-scripts --prefix controller/cron`, then `npm test --prefix
controller/cron` and `npm run build --prefix controller/cron` from the repository
root. Unit tests use hardware mocks. Do not start the scheduler to test a change
on a development computer.

The old `refactored/` notes described a superseded directory layout and APIs that
were never implemented. Git history retains them. The paths above describe the
maintained source. `StateMachine.ts` remains the coordinator; move behavior only
when the existing valve arbitration and recovery tests can prove it unchanged.
