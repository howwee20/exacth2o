const goldenAngleDegrees = 137.50776405003785;

/**
 * Returns a stable chart color for a physical pot number.
 *
 * The pot number is the only input so a pot keeps the same color regardless of
 * its experiment, controller group, or display zone. Golden-angle spacing
 * avoids the repeated colors produced by small, zone-specific palettes.
 */
export function colorForPotNumber(potNumber: number) {
  const normalizedPotNumber = Number.isFinite(potNumber) ? Math.trunc(potNumber) : 0;
  const hue = ((normalizedPotNumber * goldenAngleDegrees) % 360 + 360) % 360;
  const saturation = 72 + (Math.abs(normalizedPotNumber) % 4) * 4;
  const lightness = 40 + (Math.abs(normalizedPotNumber) % 3) * 5;

  return `hsl(${hue.toFixed(1)} ${saturation}% ${lightness}%)`;
}
