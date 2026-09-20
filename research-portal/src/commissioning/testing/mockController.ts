import { SimulatedBench, type SimWorld } from "../../autocal/simulator";
import type {
  CommandSnapshot,
  CommissioningPorts,
  ControllerStatus,
  PulseRequest,
  Reading,
  SelectedPot,
} from "../types";

// TEST DOUBLE ONLY. A mock controller that speaks the same ports as the real
// adapter: commands move through queued -> running -> succeeded on a virtual
// clock, sensor readings arrive at a slow cadence, and each server/executor gate
// and failure can be switched on. It is backed by the seeded simulator bench so
// the orchestrator can be tested end to end against a hidden hose layout.

export type MockOptions = {
  cadenceSeconds?: number;
  claimDelaySeconds?: number;
  intakeOpen?: boolean;
  executorDryRun?: boolean;
  executorManualWaterEnabled?: boolean;
  controllerState?: string;
  autoWateringPairings?: string[];
  hangCommands?: boolean;
  staleAfterPulses?: number | null;
  conflictAfterPulses?: number | null;
  silenceSensorAfterPulses?: { sensorKey: string; pulses: number } | null;
  rejectRequestAfterPulses?: number | null;
  warmupSeconds?: number;
};

type MockCommand = CommandSnapshot & { request: PulseRequest; executeAtMs: number; valveIndex: number };

export class MockController {
  readonly pulseRequests: PulseRequest[] = [];
  readonly overlapViolations: string[] = [];
  options: Required<MockOptions>;
  pulsesExecuted = 0;

  private readonly bench: SimulatedBench;
  private readonly world: SimWorld;
  private readonly epochMs = Date.parse("2026-09-22T14:00:00.000Z");
  private readonly readings: Reading[] = [];
  private readonly commands = new Map<string, MockCommand>();
  private sinceLastReading = 0;

  constructor(world: SimWorld, options: MockOptions = {}) {
    this.world = world;
    this.bench = new SimulatedBench(world);
    this.options = {
      cadenceSeconds: 60,
      claimDelaySeconds: 5,
      intakeOpen: true,
      executorDryRun: false,
      executorManualWaterEnabled: true,
      controllerState: "RUNNING",
      autoWateringPairings: [],
      hangCommands: false,
      staleAfterPulses: null,
      conflictAfterPulses: null,
      silenceSensorAfterPulses: null,
      rejectRequestAfterPulses: null,
      warmupSeconds: 30 * 60,
      ...options,
    };
    this.advance(this.options.warmupSeconds);
  }

  // The recorded (possibly wrong) pairings: valve i is recorded against sensor i.
  pots(): SelectedPot[] {
    return this.world.valves.map((valve, index) => ({
      pairingName: `Zone1-Pot${index + 1}`,
      potNumber: index + 1,
      valveKey: valve.id,
      sensorKey: this.world.sensors[index].id,
    }));
  }

  private nowMs() {
    return this.epochMs + this.bench.elapsedSeconds * 1000;
  }

  private advance(seconds: number) {
    const step = 5;
    for (let elapsed = 0; elapsed < seconds; elapsed += step) {
      const values = this.bench.sample(step);
      this.sinceLastReading += step;
      if (this.sinceLastReading >= this.options.cadenceSeconds) {
        this.sinceLastReading = 0;
        const silenced = this.options.silenceSensorAfterPulses;
        values.forEach((value, index) => {
          const sensorKey = this.world.sensors[index].id;
          if (value == null) return;
          if (silenced && silenced.sensorKey === sensorKey && this.pulsesExecuted >= silenced.pulses) return;
          this.readings.push({ sensorKey, atMs: this.nowMs(), vwc: value });
        });
      }
      this.commands.forEach((command) => {
        if (command.status !== "queued" || this.nowMs() < command.executeAtMs || this.options.hangCommands) return;
        if (this.options.executorDryRun) {
          command.status = "failed";
          command.error = "Controller executor is in dry-run mode; no controller mutation was applied";
          return;
        }
        if (!this.options.executorManualWaterEnabled) {
          command.status = "failed";
          command.error = "manual_water is disabled until the controller timed-pulse bench protocol is approved";
          return;
        }
        command.status = "running";
        const { flowMl } = this.bench.pulse(command.valveIndex, command.request.seconds);
        this.pulsesExecuted += 1;
        command.status = "succeeded";
        command.result = { action: "manual_water", failSafe: "controller_timed_pulse", durationSeconds: command.request.seconds, mockFlowMl: Math.round(flowMl) };
      });
    }
  }

  ports(): CommissioningPorts {
    return {
      now: () => this.nowMs(),
      sleep: async (ms, signal) => {
        if (signal.aborted) throw new Error("aborted");
        this.advance(Math.max(5, ms / 1000));
      },
      readControllerStatus: async (): Promise<ControllerStatus> => {
        const stale = this.options.staleAfterPulses != null && this.pulsesExecuted >= this.options.staleAfterPulses;
        return {
          observedAtMs: stale ? this.nowMs() - 3600_000 : this.nowMs() - 20_000,
          freshUntilMs: stale ? this.nowMs() - 3000_000 : this.nowMs() + 280_000,
          controllerState: this.options.controllerState,
          wateringEnabled: false,
        };
      },
      readReadings: async (sensorKeys, sinceMs) =>
        this.readings.filter((reading) => reading.atMs >= sinceMs && sensorKeys.includes(reading.sensorKey)),
      readAutoWateringPairings: async (names) => this.options.autoWateringPairings.filter((name) => names.includes(name)),
      countActiveWateringCommands: async () =>
        this.options.conflictAfterPulses != null && this.pulsesExecuted >= this.options.conflictAfterPulses ? 1 : 0,
      probePulseIntake: async () => this.options.intakeOpen
        ? { open: true, detail: "The server accepted the probe." }
        : { open: false, detail: "Manual watering remains locked until the physical valve fail-safe check is recorded." },
      requestPulse: async (request) => {
        this.pulseRequests.push(request);
        const active = Array.from(this.commands.values()).filter((command) => command.status === "queued" || command.status === "running");
        if (active.length) this.overlapViolations.push(`${request.step} requested while ${active[0].request.step} was still active`);
        if (!this.options.intakeOpen) throw new Error("Manual watering remains locked until the physical valve fail-safe check is recorded.");
        if (this.options.rejectRequestAfterPulses != null && this.pulsesExecuted >= this.options.rejectRequestAfterPulses) {
          throw new Error("Device controls are quarantined pending state reconciliation");
        }
        const valveIndex = this.pots().findIndex((pot) => pot.pairingName === request.pairingName);
        if (valveIndex < 0) throw new Error(`Unknown pairing ${request.pairingName}`);
        const id = `cmd-${this.commands.size + 1}`;
        this.commands.set(id, {
          id,
          status: "queued",
          error: null,
          result: null,
          request,
          valveIndex,
          executeAtMs: this.nowMs() + this.options.claimDelaySeconds * 1000,
        });
        return { commandId: id, operationId: `op-${this.commands.size}` };
      },
      readCommand: async (commandId) => {
        const command = this.commands.get(commandId);
        return command ? { id: command.id, status: command.status, error: command.error, result: command.result } : null;
      },
    };
  }
}
