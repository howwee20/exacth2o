import { IPairing, PairingState } from '../types/system'

export interface SafetyDecision {
  allowed: boolean
  reason?: string
  fault?: boolean
  normalHold?: boolean
}

export interface WateringBand {
  floor: number
  trigger: number
  recoveryMax: number
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isPercentValue(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 100
}

export function hasCalibration(pairing: Pick<IPairing, 'Calibration'>): boolean {
  const coefficients = pairing.Calibration?.polynomialCoefficientsCommaDelimited
  return typeof coefficients === 'string' && coefficients.trim().length > 0
}

export function isWateringConfigEnabled(pairing: Pick<IPairing, 'WTCPercentLimit' | 'ValveOpenTime' | 'MeasurementInterval'>): boolean {
  return (
    isPercentValue(pairing.WTCPercentLimit) &&
    isFiniteNumber(pairing.ValveOpenTime) &&
    pairing.ValveOpenTime > 0 &&
    isFiniteNumber(pairing.MeasurementInterval) &&
    pairing.MeasurementInterval > 0
  )
}

export function getWateringBand(
  pairing: Pick<IPairing, 'WTCPercentLimit'>,
  triggerOffsetPercent: number = 0,
  recoveryOffsetPercent: number = 0
): WateringBand {
  const floor = pairing.WTCPercentLimit
  const trigger = floor + Math.max(0, triggerOffsetPercent)
  const recoveryMax = floor + Math.max(0, recoveryOffsetPercent)

  return {
    floor,
    trigger,
    recoveryMax: Math.max(trigger, recoveryMax),
  }
}

export function isFreshMeasurement(pairing: Pick<PairingState, 'lastMeasurementAt'>, now: number, maxAgeMs: number): boolean {
  return (
    isFiniteNumber(pairing.lastMeasurementAt) &&
    pairing.lastMeasurementAt <= now + 1000 &&
    now - pairing.lastMeasurementAt <= maxAgeMs
  )
}

export function getActiveWateringWindowStart(
  pairing: Pick<PairingState, 'wateringWindowStartedAt' | 'lastValveOpenedAt'>
): number | null {
  if (isFiniteNumber(pairing.wateringWindowStartedAt)) {
    return pairing.wateringWindowStartedAt
  }

  return isFiniteNumber(pairing.lastValveOpenedAt) ? pairing.lastValveOpenedAt : null
}

export function isInsideWateringSettleWindow(
  pairing: Pick<PairingState, 'wateringWindowStartedAt' | 'lastValveOpenedAt'>,
  now: number,
  settleWindowMs: number
): boolean {
  const windowStart = getActiveWateringWindowStart(pairing)
  return (
    settleWindowMs > 0 &&
    isFiniteNumber(windowStart) &&
    windowStart <= now + 1000 &&
    now - windowStart < settleWindowMs
  )
}

export function isInsideMinimumWateringRetry(
  pairing: Pick<PairingState, 'lastValveOpenedAt'>,
  now: number,
  minRetryMs: number
): boolean {
  return (
    minRetryMs > 0 &&
    isFiniteNumber(pairing.lastValveOpenedAt) &&
    pairing.lastValveOpenedAt <= now + 1000 &&
    now - pairing.lastValveOpenedAt < minRetryMs
  )
}

export function activeWateringWindowPulseCount(
  pairing: Pick<PairingState, 'wateringWindowStartedAt' | 'wateringWindowPulseCount' | 'lastValveOpenedAt'>,
  now: number,
  settleWindowMs: number
): number {
  if (!isInsideWateringSettleWindow(pairing, now, settleWindowMs)) {
    return 0
  }

  return Math.max(0, pairing.wateringWindowPulseCount || 0)
}

export function isCorrectionEpisodeActive(
  pairing: Pick<PairingState, 'wateringWindowStartedAt' | 'wateringWindowPulseCount' | 'lastValveOpenedAt'>,
  now: number,
  settleWindowMs: number
): boolean {
  return activeWateringWindowPulseCount(pairing, now, settleWindowMs) > 0
}

export function shouldAttemptWatering(
  pairing: Pick<PairingState, 'WTCPercentLimit' | 'WTCPercentMeasured' | 'wateringWindowStartedAt' | 'wateringWindowPulseCount' | 'lastValveOpenedAt'>,
  now: number,
  settleWindowMs: number,
  triggerOffsetPercent: number = 0,
  recoveryOffsetPercent: number = 0
): boolean {
  if (!isPercentValue(pairing.WTCPercentMeasured)) {
    return false
  }

  const band = getWateringBand(pairing, triggerOffsetPercent, recoveryOffsetPercent)
  if (pairing.WTCPercentMeasured < band.trigger) {
    return true
  }

  return (
    pairing.WTCPercentMeasured < band.recoveryMax &&
    isCorrectionEpisodeActive(pairing, now, settleWindowMs)
  )
}

export function recordValveOpen(pairing: PairingState, now: number, settleWindowMs: number): void {
  const windowStart = getActiveWateringWindowStart(pairing)
  const windowActive = (
    settleWindowMs > 0 &&
    isFiniteNumber(windowStart) &&
    windowStart <= now + 1000 &&
    now - windowStart < settleWindowMs
  )

  pairing.lastValveOpenedAt = now

  if (windowActive) {
    pairing.wateringWindowStartedAt = windowStart
    pairing.wateringWindowPulseCount = Math.max(0, pairing.wateringWindowPulseCount || 0) + 1
    return
  }

  pairing.wateringWindowStartedAt = now
  pairing.wateringWindowPulseCount = 1
}

export function resetWateringWindow(pairing: PairingState): void {
  pairing.wateringWindowStartedAt = null
  pairing.wateringWindowPulseCount = 0
}

export function getValveOpenSafetyDecision(
  pairing: PairingState,
  now: number,
  maxReadingAgeMs: number,
  settleWindowMs: number = 0,
  maxPulsesPerSettleWindow: number = Number.POSITIVE_INFINITY,
  minRetryMs: number = 0,
  triggerOffsetPercent: number = 0,
  recoveryOffsetPercent: number = 0
): SafetyDecision {
  if (!isWateringConfigEnabled(pairing)) {
    return { allowed: false, reason: 'watering config disabled or invalid' }
  }

  if (!hasCalibration(pairing)) {
    return { allowed: false, reason: 'missing calibration for watering', fault: true }
  }

  if (!pairing.measurementValid) {
    return { allowed: false, reason: 'no valid sensor measurement', fault: true }
  }

  if (!pairing.wateringMeasurementValid) {
    return { allowed: false, reason: 'measurement is not valid for watering', fault: true }
  }

  if (!isFreshMeasurement(pairing, now, maxReadingAgeMs)) {
    return { allowed: false, reason: 'sensor measurement is stale', fault: true }
  }

  if (!isPercentValue(pairing.WTCPercentMeasured)) {
    return { allowed: false, reason: 'measured water content is outside 0-100 percent', fault: true }
  }

  const band = getWateringBand(pairing, triggerOffsetPercent, recoveryOffsetPercent)
  if (pairing.WTCPercentMeasured >= band.recoveryMax) {
    return {
      allowed: false,
      reason: `measured water content is at or above recovery target (${pairing.WTCPercentMeasured.toFixed(2)} >= ${band.recoveryMax.toFixed(2)})`
    }
  }

  if (
    pairing.WTCPercentMeasured >= band.trigger &&
    !isCorrectionEpisodeActive(pairing, now, settleWindowMs)
  ) {
    return {
      allowed: false,
      reason: `measured water content is above watering trigger (${pairing.WTCPercentMeasured.toFixed(2)} >= ${band.trigger.toFixed(2)})`
    }
  }

  if (isInsideMinimumWateringRetry(pairing, now, minRetryMs)) {
    return { allowed: false, reason: 'minimum watering retry interval is still active', normalHold: true }
  }

  const pulseCount = activeWateringWindowPulseCount(pairing, now, settleWindowMs)
  if (Number.isFinite(maxPulsesPerSettleWindow) && pulseCount >= maxPulsesPerSettleWindow) {
    return { allowed: false, reason: 'watering settle-window pulse limit reached', normalHold: true }
  }

  return { allowed: true }
}
