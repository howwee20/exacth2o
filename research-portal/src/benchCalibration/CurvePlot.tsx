import { evaluateCurve, type Point } from "./model";

const W = 360, H = 212, LEFT = 34, RIGHT = 350, TOP = 18, BOTTOM = 172;

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
  // The moisture axis runs between round tens.
  const bottom = Math.floor(Math.min(0, ...ys) / 10) * 10,
    top = Math.ceil(Math.max(1, ...ys) / 10) * 10;
  const plotX = (x: number) => (lo === hi ? (LEFT + RIGHT) / 2 : LEFT + 8 + ((RIGHT - LEFT - 16) * (x - lo)) / (hi - lo));
  const plotY = (y: number) => BOTTOM - ((BOTTOM - TOP) * (y - bottom)) / (top - bottom);
  return (
    <svg
      className="bench-curve-plot"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Reference VWC versus average raw probe reading, with measured points and fitted curve"
    >
      {[0, 0.5, 1].map((t) => {
        const y = bottom + t * (top - bottom);
        return (
          <g key={t}>
            <line x1={LEFT} x2={RIGHT} y1={plotY(y)} y2={plotY(y)} />
            <text x={LEFT - 7} y={plotY(y) + 3.5} textAnchor="end">
              {Number(y.toPrecision(3))}
            </text>
          </g>
        );
      })}
      <text x={plotX(lo)} y={BOTTOM + 16} textAnchor={lo === hi ? "middle" : "start"}>
        {Number(lo.toPrecision(4))}
      </text>
      {lo !== hi && (
        <text x={plotX(hi)} y={BOTTOM + 16} textAnchor="end">
          {Number(hi.toPrecision(4))}
        </text>
      )}
      <text x={(LEFT + RIGHT) / 2} y={H - 6} textAnchor="middle">
        Raw reading
      </text>
      <text x={LEFT} y={TOP - 7}>
        VWC %
      </text>
      <polyline points={curve.map((p) => `${plotX(p.x)},${plotY(p.y)}`).join(" ")} />
      {points.map((p, i) => (
        <circle key={i} cx={plotX(p.x)} cy={plotY(p.y)} r="4">
          <title>
            {p.x} raw, {p.y}% VWC
          </title>
        </circle>
      ))}
    </svg>
  );
}
