/**
 * Input state machine for a press-and-hold control.
 *
 * Exactly one input owns a hold: the pointer (mouse, touch or pen) or the key that
 * started it. Other pointers and keys cannot start, extend, switch or transfer it.
 * Anything that means the operator may no longer be deliberately holding ends it:
 * release, cancel, lost capture, Escape, blur, the page being hidden or unloaded,
 * the control going away, being disabled, or its destination changing. After any
 * end, only a fresh press starts again; nothing ever restarts on its own.
 */

export type HoldInputEvent =
  | { type: "pointerdown"; pointerId: number; pointerType: string; button: number; isPrimary: boolean }
  | { type: "pointerup"; pointerId: number }
  | { type: "pointercancel"; pointerId: number }
  | { type: "lostpointercapture"; pointerId: number }
  | { type: "keydown"; key: string; repeat: boolean }
  | { type: "keyup"; key: string }
  | { type: "interrupt"; reason: HoldInterruptReason };

export type HoldInterruptReason =
  | "escape"
  | "blur"
  | "hidden"
  | "pagehide"
  | "unmount"
  | "disabled"
  | "destination"
  | "offline"
  | "signout";

export type HoldInputState =
  | { kind: "idle" }
  | { kind: "pointer"; pointerId: number; pointerType: string }
  | { kind: "key"; key: string };

export type HoldInputAction = { action: "press"; source: string } | { action: "release"; reason: string } | null;

const holdKeys = new Set([" ", "Enter"]);

export class HoldInputMachine {
  state: HoldInputState = { kind: "idle" };

  get holding() {
    return this.state.kind !== "idle";
  }

  handle(event: HoldInputEvent): HoldInputAction {
    const state = this.state;
    switch (event.type) {
      case "pointerdown": {
        // Only an idle control starts, only from the primary pointer, only the main button.
        if (state.kind !== "idle" || !event.isPrimary) return null;
        if (event.pointerType === "mouse" && event.button !== 0) return null;
        this.state = { kind: "pointer", pointerId: event.pointerId, pointerType: event.pointerType };
        return { action: "press", source: event.pointerType || "pointer" };
      }
      case "pointerup":
      case "pointercancel":
      case "lostpointercapture": {
        if (state.kind !== "pointer" || state.pointerId !== event.pointerId) return null;
        this.state = { kind: "idle" };
        return { action: "release", reason: event.type };
      }
      case "keydown": {
        if (event.key === "Escape") {
          if (state.kind === "idle") return null;
          this.state = { kind: "idle" };
          return { action: "release", reason: "escape" };
        }
        // Auto-repeat never starts or re-starts a hold.
        if (!holdKeys.has(event.key) || event.repeat || state.kind !== "idle") return null;
        this.state = { kind: "key", key: event.key };
        return { action: "press", source: "keyboard" };
      }
      case "keyup": {
        if (state.kind !== "key" || state.key !== event.key) return null;
        this.state = { kind: "idle" };
        return { action: "release", reason: "keyup" };
      }
      case "interrupt": {
        if (state.kind === "idle") return null;
        this.state = { kind: "idle" };
        return { action: "release", reason: event.reason };
      }
      default:
        return null;
    }
  }
}
