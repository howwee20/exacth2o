export const TESTBED_PROJECT_ID = 'ef09cfa5-2efe-49bb-b628-3272300092f7';
export const TESTBED_DEVICE_ID = 'a3aff410ae08406cbf6a3545df4c7472';
export const TESTBED_NAMES = ['Sensor One', 'Sensor Two', 'Sensor Three', 'Sensor Four'];
export const isTestbed = (project, device) => project === TESTBED_PROJECT_ID && device === TESTBED_DEVICE_ID;
export function validateTestbedWater(payload) {
  if (!Array.isArray(payload?.pairing_names) || payload.pairing_names.length !== 1 || !TESTBED_NAMES.includes(payload.pairing_names[0])) {
    throw new Error('Choose one of the four commissioned testbed pots');
  }
  if (!Number.isInteger(payload.duration_seconds) || payload.duration_seconds < 2 || payload.duration_seconds > 5) {
    throw new Error('Testbed watering must be 2 to 5 seconds');
  }
}

export function assertTestbedPairing(payload, pairings) {
  validateTestbedWater(payload);
  const index = TESTBED_NAMES.indexOf(payload.pairing_names[0]);
  const matches = pairings.filter(p => p.name === TESTBED_NAMES[index]);
  if (matches.length !== 1 || String(matches[0].Sensor?.address) !== String(index + 1)
      || String(matches[0].Sensor?.boardSerialId) !== 'D30GQN2Q'
      || Number(matches[0].Valve?.relayAddress) !== 32
      || Number(matches[0].Valve?.address) !== index + 1) {
    throw new Error('The commissioned testbed pairing changed. Verify the physical map before watering.');
  }
}
