"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFiniteNumber = isFiniteNumber;
exports.isPercentValue = isPercentValue;
exports.hasCalibration = hasCalibration;
exports.isWateringConfigEnabled = isWateringConfigEnabled;
exports.getWateringBand = getWateringBand;
exports.isFreshMeasurement = isFreshMeasurement;
exports.getActiveWateringWindowStart = getActiveWateringWindowStart;
exports.isInsideWateringSettleWindow = isInsideWateringSettleWindow;
exports.isInsideMinimumWateringRetry = isInsideMinimumWateringRetry;
exports.activeWateringWindowPulseCount = activeWateringWindowPulseCount;
exports.isCorrectionEpisodeActive = isCorrectionEpisodeActive;
exports.shouldAttemptWatering = shouldAttemptWatering;
exports.recordValveOpen = recordValveOpen;
exports.resetWateringWindow = resetWateringWindow;
exports.getValveOpenSafetyDecision = getValveOpenSafetyDecision;
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isPercentValue(value) {
    return isFiniteNumber(value) && value >= 0 && value <= 100;
}
function hasCalibration(pairing) {
    var _a;
    const coefficients = (_a = pairing.Calibration) === null || _a === void 0 ? void 0 : _a.polynomialCoefficientsCommaDelimited;
    return typeof coefficients === 'string' && coefficients.trim().length > 0;
}
function isWateringConfigEnabled(pairing) {
    return (isPercentValue(pairing.WTCPercentLimit) &&
        isFiniteNumber(pairing.ValveOpenTime) &&
        pairing.ValveOpenTime > 0 &&
        isFiniteNumber(pairing.MeasurementInterval) &&
        pairing.MeasurementInterval > 0);
}
function getWateringBand(pairing, triggerOffsetPercent = 0, recoveryOffsetPercent = 0) {
    const floor = pairing.WTCPercentLimit;
    const trigger = floor + Math.max(0, triggerOffsetPercent);
    const recoveryMax = floor + Math.max(0, recoveryOffsetPercent);
    return {
        floor,
        trigger,
        recoveryMax: Math.max(trigger, recoveryMax),
    };
}
function isFreshMeasurement(pairing, now, maxAgeMs) {
    return (isFiniteNumber(pairing.lastMeasurementAt) &&
        pairing.lastMeasurementAt <= now + 1000 &&
        now - pairing.lastMeasurementAt <= maxAgeMs);
}
function getActiveWateringWindowStart(pairing) {
    if (isFiniteNumber(pairing.wateringWindowStartedAt)) {
        return pairing.wateringWindowStartedAt;
    }
    return isFiniteNumber(pairing.lastValveOpenedAt) ? pairing.lastValveOpenedAt : null;
}
function isInsideWateringSettleWindow(pairing, now, settleWindowMs) {
    const windowStart = getActiveWateringWindowStart(pairing);
    return (settleWindowMs > 0 &&
        isFiniteNumber(windowStart) &&
        windowStart <= now + 1000 &&
        now - windowStart < settleWindowMs);
}
function isInsideMinimumWateringRetry(pairing, now, minRetryMs) {
    return (minRetryMs > 0 &&
        isFiniteNumber(pairing.lastValveOpenedAt) &&
        pairing.lastValveOpenedAt <= now + 1000 &&
        now - pairing.lastValveOpenedAt < minRetryMs);
}
function activeWateringWindowPulseCount(pairing, now, settleWindowMs) {
    if (!isInsideWateringSettleWindow(pairing, now, settleWindowMs)) {
        return 0;
    }
    return Math.max(0, pairing.wateringWindowPulseCount || 0);
}
function isCorrectionEpisodeActive(pairing, now, settleWindowMs) {
    return activeWateringWindowPulseCount(pairing, now, settleWindowMs) > 0;
}
function shouldAttemptWatering(pairing, now, settleWindowMs, triggerOffsetPercent = 0, recoveryOffsetPercent = 0) {
    if (!isPercentValue(pairing.WTCPercentMeasured)) {
        return false;
    }
    const band = getWateringBand(pairing, triggerOffsetPercent, recoveryOffsetPercent);
    if (pairing.WTCPercentMeasured < band.trigger) {
        return true;
    }
    return (pairing.WTCPercentMeasured < band.recoveryMax &&
        isCorrectionEpisodeActive(pairing, now, settleWindowMs));
}
function recordValveOpen(pairing, now, settleWindowMs) {
    const windowStart = getActiveWateringWindowStart(pairing);
    const windowActive = (settleWindowMs > 0 &&
        isFiniteNumber(windowStart) &&
        windowStart <= now + 1000 &&
        now - windowStart < settleWindowMs);
    pairing.lastValveOpenedAt = now;
    if (windowActive) {
        pairing.wateringWindowStartedAt = windowStart;
        pairing.wateringWindowPulseCount = Math.max(0, pairing.wateringWindowPulseCount || 0) + 1;
        return;
    }
    pairing.wateringWindowStartedAt = now;
    pairing.wateringWindowPulseCount = 1;
}
function resetWateringWindow(pairing) {
    pairing.wateringWindowStartedAt = null;
    pairing.wateringWindowPulseCount = 0;
}
function getValveOpenSafetyDecision(pairing, now, maxReadingAgeMs, settleWindowMs = 0, maxPulsesPerSettleWindow = Number.POSITIVE_INFINITY, minRetryMs = 0, triggerOffsetPercent = 0, recoveryOffsetPercent = 0) {
    if (!isWateringConfigEnabled(pairing)) {
        return { allowed: false, reason: 'watering config disabled or invalid' };
    }
    if (!hasCalibration(pairing)) {
        return { allowed: false, reason: 'missing calibration for watering', fault: true };
    }
    if (!pairing.measurementValid) {
        return { allowed: false, reason: 'no valid sensor measurement', fault: true };
    }
    if (!pairing.wateringMeasurementValid) {
        return { allowed: false, reason: 'measurement is not valid for watering', fault: true };
    }
    if (!isFreshMeasurement(pairing, now, maxReadingAgeMs)) {
        return { allowed: false, reason: 'sensor measurement is stale', fault: true };
    }
    if (!isPercentValue(pairing.WTCPercentMeasured)) {
        return { allowed: false, reason: 'measured water content is outside 0-100 percent', fault: true };
    }
    const band = getWateringBand(pairing, triggerOffsetPercent, recoveryOffsetPercent);
    if (pairing.WTCPercentMeasured >= band.recoveryMax) {
        return {
            allowed: false,
            reason: `measured water content is at or above recovery target (${pairing.WTCPercentMeasured.toFixed(2)} >= ${band.recoveryMax.toFixed(2)})`
        };
    }
    if (pairing.WTCPercentMeasured >= band.trigger &&
        !isCorrectionEpisodeActive(pairing, now, settleWindowMs)) {
        return {
            allowed: false,
            reason: `measured water content is above watering trigger (${pairing.WTCPercentMeasured.toFixed(2)} >= ${band.trigger.toFixed(2)})`
        };
    }
    if (isInsideMinimumWateringRetry(pairing, now, minRetryMs)) {
        return { allowed: false, reason: 'minimum watering retry interval is still active', normalHold: true };
    }
    const pulseCount = activeWateringWindowPulseCount(pairing, now, settleWindowMs);
    if (Number.isFinite(maxPulsesPerSettleWindow) && pulseCount >= maxPulsesPerSettleWindow) {
        return { allowed: false, reason: 'watering settle-window pulse limit reached', normalHold: true };
    }
    return { allowed: true };
}
