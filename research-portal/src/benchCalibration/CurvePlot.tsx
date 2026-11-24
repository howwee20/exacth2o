import { evaluateCurve, type Point } from "./model";

export function CurvePlot({ points, coefficients }: { points: Point[]; coefficients: number[] }) {
  if (!points.length) return null;
  const xs = points.map((p) => p.x);
  const lo = Math.min(...xs),
    hi = Math.max(...xs);
  const curve = coefficients.length
    ? Array.from({ length: 101 }, (_, i) => {
        const x = lo + ((hi - lo) * i) / 100;
        return { x, y: evaluateCurve(coefficients, x) };
      }).filter((p) => Number.isFinite(p.y))
    : [];
  const ys = [...points, ...curve].map((p) => p.y);
  const bottom = Math.min(0, ...ys),
    top = Math.max(1, ...ys);
  const plotX = (x: number) => (lo === hi ? 167 : 43 + (257 * (x - lo)) / (hi - lo));
  const plotY = (y: number) => 151 - (125 * (y - bottom)) / (top - bottom);
  return (
    <svg
      className="bench-curve-plot"
      viewBox="0 0 320 191"
      role="img"
      aria-label="Reference VWC versus average raw probe reading, with measured points and fitted curve"
    >
      <text x="8" y="12">
        Reference VWC (%)
      </text>
      {[0, 0.5, 1].map((t) => {
        const y = bottom + t * (top - bottom);
        return (
          <g key={t}>
            <line x1="42" x2="301" y1={plotY(y)} y2={plotY(y)} />
            <text x="37" y={plotY(y) + 4} textAnchor="end">
              {Number(y.toPrecision(3))}
            </text>
          </g>
        );
      })}
      <text x="43" y="167">
        {Number(lo.toPrecision(4))}
      </text>
      <text x="300" y="167" textAnchor="end">
        {Number(hi.toPrecision(4))}
      </text>
      <text x="170" y="185" textAnchor="middle">
        Average raw probe reading
      </text>
      <polyline points={curve.map((p) => `${plotX(p.x)},${plotY(p.y)}`).join(" ")} />
      {points.map((p, i) => (
        <circle key={i} cx={plotX(p.x)} cy={plotY(p.y)} r="3.5">
          <title>
            {p.x} raw, {p.y}% VWC
          </title>
        </circle>
      ))}
    </svg>
  );
}
