import type { SensorReading } from "./types";

export const calibrationReadySampleCount = 25;

export type CalibrationFitPoint = {
  rawValue: number;
  referenceValue: number;
};

export type CalibrationFit = {
  fitType: "linear" | "quadratic";
  coefficients: [number, number] | [number, number, number];
  equation: string;
  sampleCount: number;
  rmse: number;
  mae: number;
  rSquared: number;
  maxError: number;
  rawMin: number;
  rawMax: number;
  referenceMin: number;
  referenceMax: number;
  readyToSet: boolean;
};

function finitePoints(points: CalibrationFitPoint[]) {
  return points.filter((point) => Number.isFinite(point.rawValue) && Number.isFinite(point.referenceValue));
}

function evaluate(coefficients: number[], x: number) {
  return coefficients.reduceRight((accumulator, coefficient) => accumulator * x + coefficient, 0);
}

function metrics(points: CalibrationFitPoint[], coefficients: number[]) {
  const meanReference = points.reduce((sum, point) => sum + point.referenceValue, 0) / points.length;
  const errors = points.map((point) => evaluate(coefficients, point.rawValue) - point.referenceValue);
  const squaredErrors = errors.map((error) => error ** 2);
  const residualSum = squaredErrors.reduce((sum, error) => sum + error, 0);
  const totalSum = points.reduce((sum, point) => sum + (point.referenceValue - meanReference) ** 2, 0);
  return {
    rmse: Math.sqrt(residualSum / points.length),
    mae: errors.reduce((sum, error) => sum + Math.abs(error), 0) / points.length,
    rSquared: totalSum > 0 ? 1 - residualSum / totalSum : residualSum === 0 ? 1 : 0,
    maxError: Math.max(...errors.map(Math.abs)),
  };
}

function linearCoefficients(points: CalibrationFitPoint[]): [number, number] {
  const meanX = points.reduce((sum, point) => sum + point.rawValue, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.referenceValue, 0) / points.length;
  const variance = points.reduce((sum, point) => sum + (point.rawValue - meanX) ** 2, 0);
  if (variance <= Number.EPSILON) throw new Error("The ExactH2O readings need more variation before an equation can be created.");
  const covariance = points.reduce(
    (sum, point) => sum + (point.rawValue - meanX) * (point.referenceValue - meanY),
    0,
  );
  const slope = covariance / variance;
  return [meanY - slope * meanX, slope];
}

function solveThreeByThree(matrix: number[][], vector: number[]) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let pivot = 0; pivot < 3; pivot += 1) {
    let bestRow = pivot;
    for (let row = pivot + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[bestRow][pivot])) bestRow = row;
    }
    if (Math.abs(augmented[bestRow][pivot]) < 1e-12) throw new Error("The readings do not span enough range for a stable curve.");
    [augmented[pivot], augmented[bestRow]] = [augmented[bestRow], augmented[pivot]];
    const pivotValue = augmented[pivot][pivot];
    for (let column = pivot; column < 4; column += 1) augmented[pivot][column] /= pivotValue;
    for (let row = 0; row < 3; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      for (let column = pivot; column < 4; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }
  return augmented.map((row) => row[3]);
}

function quadraticCoefficients(points: CalibrationFitPoint[]): [number, number, number] {
  const meanX = points.reduce((sum, point) => sum + point.rawValue, 0) / points.length;
  const scale = Math.sqrt(points.reduce((sum, point) => sum + (point.rawValue - meanX) ** 2, 0) / points.length);
  if (scale <= Number.EPSILON) throw new Error("The ExactH2O readings need more variation before a curve can be created.");
  const normalized = points.map((point) => ({ z: (point.rawValue - meanX) / scale, y: point.referenceValue }));
  const sums = normalized.reduce<{
    z: number;
    z2: number;
    z3: number;
    z4: number;
    y: number;
    yz: number;
    yz2: number;
  }>(
    (value, point) => ({
      z: value.z + point.z,
      z2: value.z2 + point.z ** 2,
      z3: value.z3 + point.z ** 3,
      z4: value.z4 + point.z ** 4,
      y: value.y + point.y,
      yz: value.yz + point.y * point.z,
      yz2: value.yz2 + point.y * point.z ** 2,
    }),
    { z: 0, z2: 0, z3: 0, z4: 0, y: 0, yz: 0, yz2: 0 },
  );
  const [a, b, c] = solveThreeByThree(
    [
      [points.length, sums.z, sums.z2],
      [sums.z, sums.z2, sums.z3],
      [sums.z2, sums.z3, sums.z4],
    ],
    [sums.y, sums.yz, sums.yz2],
  );
  const rawQuadratic = c / scale ** 2;
  const rawLinear = b / scale - (2 * c * meanX) / scale ** 2;
  const rawIntercept = a - (b * meanX) / scale + (c * meanX ** 2) / scale ** 2;
  return [rawIntercept, rawLinear, rawQuadratic];
}

function displayNumber(value: number) {
  if (Math.abs(value) >= 1000 || (Math.abs(value) > 0 && Math.abs(value) < 0.001)) return value.toExponential(4);
  return value.toFixed(5).replace(/\.?0+$/, "");
}

function equationFor(coefficients: number[]) {
  const terms = coefficients.map((coefficient, index) => {
    const value = `${displayNumber(Math.abs(coefficient))}${index === 0 ? "" : index === 1 ? "x" : `x^${index}`}`;
    if (index === 0) return coefficient < 0 ? `-${value}` : value;
    return `${coefficient < 0 ? "-" : "+"} ${value}`;
  });
  return `f(x) = ${terms.join(" ")}`;
}

export function fitCalibration(points: CalibrationFitPoint[]): CalibrationFit {
  const usable = finitePoints(points);
  if (usable.length < 3) throw new Error("Add at least 3 matched readings to create a preview equation.");
  const linear = linearCoefficients(usable);
  const linearMetrics = metrics(usable, linear);
  let coefficients: [number, number] | [number, number, number] = linear;
  let fitType: CalibrationFit["fitType"] = "linear";
  let selectedMetrics = linearMetrics;

  if (usable.length >= 8) {
    try {
      const quadratic = quadraticCoefficients(usable);
      const candidateMetrics = metrics(usable, quadratic);
      if (candidateMetrics.rmse <= linearMetrics.rmse * 0.85) {
        coefficients = quadratic;
        fitType = "quadratic";
        selectedMetrics = candidateMetrics;
      }
    } catch {
      // A stable linear fit is safer than forcing an ill-conditioned curve.
    }
  }

  const rawValues = usable.map((point) => point.rawValue);
  const referenceValues = usable.map((point) => point.referenceValue);
  return {
    fitType,
    coefficients,
    equation: equationFor(coefficients),
    sampleCount: usable.length,
    ...selectedMetrics,
    rawMin: Math.min(...rawValues),
    rawMax: Math.max(...rawValues),
    referenceMin: Math.min(...referenceValues),
    referenceMax: Math.max(...referenceValues),
    readyToSet: usable.length >= calibrationReadySampleCount,
  };
}

export function nearestCalibrationReading(
  readings: SensorReading[],
  pairingName: string,
  referenceRecordedAt: string,
  toleranceSeconds: number,
) {
  const targetTime = new Date(referenceRecordedAt).getTime();
  if (!Number.isFinite(targetTime)) return null;
  const nearest = readings
    .filter((reading) => reading.pairing_name === pairingName)
    .map((reading) => ({ reading, deltaMs: Math.abs(new Date(reading.device_recorded_at).getTime() - targetTime) }))
    .filter((candidate) => Number.isFinite(candidate.deltaMs))
    .sort((left, right) => left.deltaMs - right.deltaMs || right.reading.id - left.reading.id)[0];
  if (!nearest || nearest.deltaMs > toleranceSeconds * 1000) return null;
  return { reading: nearest.reading, deltaSeconds: Math.round(nearest.deltaMs / 1000) };
}
