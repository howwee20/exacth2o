export type FitMode = "linear" | "cubic" | "manual";
export type Cell = { value: string; capturedAt?: string; source?: "direct" | "logged" };
export type Sample = { id: string; vwc: string; cells: Record<string, Cell> };
export type Worksheet = { probes: string[]; rows: Sample[]; mode: FitMode; manual: string[] };
export function isWorksheet(value: unknown): value is Worksheet {
  if (!value || typeof value !== "object") return false;
  const sheet = value as Partial<Worksheet>;
  return (
    Array.isArray(sheet.probes) &&
    sheet.probes.every((key) => typeof key === "string") &&
    ["linear", "cubic", "manual"].includes(sheet.mode ?? "") &&
    Array.isArray(sheet.manual) &&
    sheet.manual.length === 6 &&
    sheet.manual.every((v) => typeof v === "string") &&
    Array.isArray(sheet.rows) &&
    sheet.rows.length >= 4 &&
    sheet.rows.length <= 10 &&
    sheet.rows.every(
      (row) =>
        row &&
        typeof row.id === "string" &&
        typeof row.vwc === "string" &&
        row.cells &&
        typeof row.cells === "object" &&
        Object.values(row.cells).every((cell) => cell && typeof cell.value === "string"),
    )
  );
}

export type Point = { x: number; y: number };

export function emptyWorksheet(): Worksheet {
  return {
    probes: [],
    mode: "linear",
    manual: Array(6).fill(""),
    rows: [10, 20, 40, 50, 70, 80].map((vwc) => ({ id: crypto.randomUUID(), vwc: String(vwc), cells: {} })),
  };
}

export function sampleMean(row: Sample, probes: string[]) {
  const values = probes
    .map((key) => row.cells[key]?.value.trim())
    .filter((value) => value !== undefined && value !== "");
  if (!values.length) return null;
  const numbers = values.map(Number);
  return numbers.every(Number.isFinite) ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
}

export function evaluateCurve(coefficients: number[], x: number) {
  return coefficients.reduceRight((sum, c) => sum * x + c, 0);
}

// Fit on a centered, scaled axis, then convert back to the ascending powers the controller accepts.
function polynomialFit(points: Point[], degree: number) {
  const xs = points.map((p) => p.x);
  if (new Set(xs).size < degree + 1) throw new Error(`Use at least ${degree + 1} distinct probe averages.`);
  const center = (Math.min(...xs) + Math.max(...xs)) / 2;
  const spread = Math.max(...xs.map((x) => Math.abs(x - center)));
  const scaled = points.map(({ x, y }) => ({ x: (x - center) / spread, y }));
  const count = degree + 1;
  const matrix = Array.from({ length: count }, (_, r) => [
    ...Array.from({ length: count }, (_, c) => scaled.reduce((sum, p) => sum + p.x ** (r + c), 0)),
    scaled.reduce((sum, p) => sum + p.y * p.x ** r, 0),
  ]);
  for (let col = 0; col < count; col++) {
    let pivot = col;
    for (let r = col + 1; r < count; r++) if (Math.abs(matrix[r][col]) > Math.abs(matrix[pivot][col])) pivot = r;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    const divisor = matrix[col][col];
    if (Math.abs(divisor) < 1e-10) throw new Error("The probe averages are too close together for this fit.");
    matrix[col] = matrix[col].map((value) => value / divisor);
    for (let r = 0; r < count; r++) {
      if (r === col) continue;
      const ratio = matrix[r][col];
      matrix[r] = matrix[r].map((value, c) => value - ratio * matrix[col][c]);
    }
  }
  let coefficients = [matrix[degree][count]];
  for (let i = degree - 1; i >= 0; i--) {
    const next = Array(coefficients.length + 1).fill(0) as number[];
    coefficients.forEach((value, power) => {
      next[power] -= (value * center) / spread;
      next[power + 1] += value / spread;
    });
    next[0] += matrix[i][count];
    coefficients = next;
  }
  return coefficients;
}

export function analyze(sheet: Worksheet) {
  const points: Point[] = [];
  let coefficients: number[] = [];
  try {
    for (const row of sheet.rows) {
      const x = sampleMean(row, sheet.probes);
      if (x === null) continue;
      const y = Number(row.vwc);
      if (!row.vwc.trim() || !Number.isFinite(y) || y < 0 || y > 100)
        throw new Error("Enter a reference VWC between 0 and 100 for each measured row.");
      if (sheet.probes.some((key) => !row.cells[key]?.value.trim()))
        throw new Error("Complete each measured row for all selected probes.");
      points.push({ x, y });
    }
    if (sheet.mode === "manual") {
      if (!sheet.manual.some((value) => value.trim()))
        throw new Error("Enter coefficients for your known equation.");
      coefficients = sheet.manual.map((value) => Number(value.trim() || 0));
      while (coefficients.length > 1 && coefficients.at(-1) === 0) coefficients.pop();
    } else {
      if (points.length < 4)
        throw new Error(
          `Complete ${4 - points.length} more reference row${points.length === 3 ? "" : "s"} to fit a curve.`,
        );
      coefficients = polynomialFit(points, sheet.mode === "cubic" ? 3 : 1);
    }
    if (!coefficients.every(Number.isFinite)) throw new Error("The equation contains an invalid coefficient.");
    const mean = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    const total = points.reduce((sum, p) => sum + (p.y - mean) ** 2, 0);
    const residual = points.reduce((sum, p) => sum + (evaluateCurve(coefficients, p.x) - p.y) ** 2, 0);
    return { points, coefficients, r2: total > 0 ? 1 - residual / total : null, error: "" };
  } catch (error) {
    return { points, coefficients: [], r2: null, error: (error as Error).message };
  }
}

export function equation(coefficients: number[]) {
  // Terms the curve does not use are left out.
  const terms = coefficients
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c !== 0)
    .map(({ c, i }, n) => {
      const sign = n ? (c < 0 ? "− " : "+ ") : c < 0 ? "−" : "";
      return `${sign}${Number(Math.abs(c).toPrecision(6))}${["", "x", "x²", "x³", "x⁴", "x⁵"][i] ?? "x^" + i}`;
    });
  return "VWC = " + (terms.join(" ") || "0");
}

export function controllerLibrary(items: unknown[]) {
  const library = new Map<string, number[]>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = row.name;
    const raw = row.polynomialCoefficientsCommaDelimited;
    if (typeof name !== "string" || typeof raw !== "string" || !raw.trim()) continue;
    const coefficients = raw.split(",").map((value) => (value.trim() ? Number(value) : NaN));
    if (coefficients.every(Number.isFinite)) library.set(name, coefficients);
  }
  return library;
}

export function sameCurve(a: number[], b: number[]) {
  const length = Math.max(a.length, b.length);
  return Array.from({ length }, (_, i) => (a[i] ?? 0) === (b[i] ?? 0)).every(Boolean);
}
