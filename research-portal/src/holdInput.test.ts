import { describe, expect, it } from 'vitest';
import { HoldInputMachine } from './holdInput';

const down = (pointerId: number, pointerType = 'touch', extra: { button?: number; isPrimary?: boolean } = {}) =>
  ({ type: 'pointerdown' as const, pointerId, pointerType, button: extra.button ?? 0, isPrimary: extra.isPrimary ?? true });

describe('press-and-hold input', () => {
  it('starts on a primary press of mouse, touch or pen, and only the same pointer ends it', () => {
    for (const type of ['mouse', 'touch', 'pen']) {
      const input = new HoldInputMachine();
      expect(input.handle(down(1, type))).toEqual({ action: 'press', source: type });
      expect(input.handle({ type: 'pointerup', pointerId: 2 })).toBeNull();
      expect(input.holding).toBe(true);
      expect(input.handle({ type: 'pointerup', pointerId: 1 })).toEqual({ action: 'release', reason: 'pointerup' });
      expect(input.holding).toBe(false);
    }
  });

  it('ignores secondary mouse buttons, non-primary touches, and a second finger during a hold', () => {
    const input = new HoldInputMachine();
    expect(input.handle(down(1, 'mouse', { button: 2 }))).toBeNull();
    expect(input.handle(down(1, 'touch', { isPrimary: false }))).toBeNull();
    expect(input.handle(down(1))).toEqual({ action: 'press', source: 'touch' });
    expect(input.handle(down(2))).toBeNull();
    // The second finger lifting does not end the first finger's hold.
    expect(input.handle({ type: 'pointerup', pointerId: 2 })).toBeNull();
    expect(input.holding).toBe(true);
  });

  it('ends on cancel, lost capture, Escape, blur, hidden page, unload, unmount, disable, destination change, offline, sign-out', () => {
    const endings = [
      { type: 'pointercancel', pointerId: 1 },
      { type: 'lostpointercapture', pointerId: 1 },
      { type: 'keydown', key: 'Escape', repeat: false },
      ...(['blur', 'hidden', 'pagehide', 'unmount', 'disabled', 'destination', 'offline', 'signout'] as const).map((reason) => ({ type: 'interrupt', reason })),
    ] as const;
    for (const ending of endings) {
      const input = new HoldInputMachine();
      input.handle(down(1));
      const action = input.handle(ending as never);
      expect(action?.action, JSON.stringify(ending)).toBe('release');
      expect(input.holding).toBe(false);
      // Nothing restarts on its own.
      expect(input.handle({ type: 'pointerup', pointerId: 1 })).toBeNull();
    }
  });

  it('keyboard: Space or Enter holds until the same key is released; auto-repeat never restarts', () => {
    const input = new HoldInputMachine();
    expect(input.handle({ type: 'keydown', key: ' ', repeat: true })).toBeNull();
    expect(input.handle({ type: 'keydown', key: ' ', repeat: false })).toEqual({ action: 'press', source: 'keyboard' });
    expect(input.handle({ type: 'keydown', key: ' ', repeat: true })).toBeNull();
    expect(input.handle({ type: 'keydown', key: 'Enter', repeat: false })).toBeNull();
    expect(input.handle({ type: 'keyup', key: 'Enter' })).toBeNull();
    expect(input.handle({ type: 'keyup', key: ' ' })).toEqual({ action: 'release', reason: 'keyup' });
    // A repeat after release cannot start water again.
    expect(input.handle({ type: 'keydown', key: ' ', repeat: true })).toBeNull();
  });

  it('a pointer cannot take over a keyboard hold, nor a key a pointer hold', () => {
    const keyboard = new HoldInputMachine();
    keyboard.handle({ type: 'keydown', key: 'Enter', repeat: false });
    expect(keyboard.handle(down(1))).toBeNull();
    expect(keyboard.handle({ type: 'pointerup', pointerId: 1 })).toBeNull();
    expect(keyboard.holding).toBe(true);
    const pointer = new HoldInputMachine();
    pointer.handle(down(5, 'pen'));
    expect(pointer.handle({ type: 'keydown', key: ' ', repeat: false })).toBeNull();
    expect(pointer.handle({ type: 'keyup', key: ' ' })).toBeNull();
    expect(pointer.holding).toBe(true);
  });
});
