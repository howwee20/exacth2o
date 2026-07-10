/**
 * The owner-health aggregate can expose current config sections inside its
 * status/health payloads even when the optional dedicated config routes return
 * 404. Only accept sections observed in the current response, never values
 * carried forward from the previous mirror, and require every safety-critical
 * section to be non-empty.
 *
 * @param {{
 *   includeConfig: unknown,
 *   pairingsObserved: unknown,
 *   boardObserved: unknown,
 *   sensorsObserved: unknown,
 *   valvesObserved: unknown,
 *   pairingCount: number,
 *   boardCount: number,
 *   sensorCount: number,
 *   valveCount: number,
 * }} input
 */
export function shouldWriteObservedConfig(input) {
  return input.includeConfig === true &&
    input.pairingsObserved === true &&
    input.boardObserved === true &&
    input.sensorsObserved === true &&
    input.valvesObserved === true &&
    input.pairingCount > 0 &&
    input.boardCount > 0 &&
    input.sensorCount > 0 &&
    input.valveCount > 0;
}
