import { useSyncExternalStore } from "react";

/**
 * What this browser tab is currently doing with the controller's valves, shared by
 * autocalibration (Settings → Autocalibrate) and manual hold-to-water troubleshooting.
 *
 * The controller arbitrates ownership itself (one output at a time, manual control
 * first). This store is the portal's side of the same rule: before a hold starts, an
 * autocalibration run in this tab is interrupted (never silently continued with a
 * baseline the manual watering contaminates), and Stop ends whatever this tab drives.
 */
export type AutocalActivity = {
  kind: "autocalibration";
  runId: string;
  label: string;
  /** Stops further pulses and marks the run interrupted by manual watering. */
  interruptForManual: (label: string) => void;
  stop: () => void;
};

export type HoldActivity = {
  kind: "manual_hold";
  sessionId: string;
  label: string;
  stop: () => void;
};

type Snapshot = { autocal: AutocalActivity | null; hold: HoldActivity | null };

class ControllerOwnership {
  private snapshot: Snapshot = { autocal: null, hold: null };
  private readonly listeners = new Set<() => void>();

  private set(next: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    this.listeners.forEach((listener) => listener());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  claimAutocal(activity: AutocalActivity) {
    this.set({ autocal: activity });
    return () => {
      if (this.snapshot.autocal?.runId === activity.runId) this.set({ autocal: null });
    };
  }

  claimHold(activity: HoldActivity) {
    this.set({ hold: activity });
    return () => {
      if (this.snapshot.hold?.sessionId === activity.sessionId) this.set({ hold: null });
    };
  }

  /** Manual troubleshooting takes priority: interrupt this tab's run before the hold starts. */
  interruptAutocalForManual(label: string) {
    const autocal = this.snapshot.autocal;
    if (!autocal) return false;
    autocal.interruptForManual(label);
    return true;
  }

  /** The shared Stop: ends this tab's hold and stops its autocalibration run. */
  stopAll() {
    this.snapshot.hold?.stop();
    this.snapshot.autocal?.stop();
  }
}

export const controllerOwnership = new ControllerOwnership();

export function useControllerOwnership() {
  return useSyncExternalStore(controllerOwnership.subscribe, controllerOwnership.getSnapshot, controllerOwnership.getSnapshot);
}
