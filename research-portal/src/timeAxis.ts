const hour = 3_600_000;
const steps = [1, 2, 3, 6, 12, 24, 48, 168, 336, 720];

/** Calendar boundaries in the reader's local zone, including daylight-saving transitions. */
export function timeTicks(domain: { startMs: number; endMs: number }, width: number, minGapPx = 74) {
  const span = Math.max(1, domain.endMs - domain.startMs);
  const step = steps.find((hours) => hours * hour / span * width >= minGapPx) ?? steps.at(-1)!;
  const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  const hourFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric" });
  const cursor = new Date(domain.startMs);
  cursor.setHours(0, 0, 0, 0);
  const advance = () => {
    if (step >= 24) cursor.setDate(cursor.getDate() + step / 24);
    else cursor.setHours(cursor.getHours() + step);
  };
  while (cursor.getTime() < domain.startMs) advance();
  const ticks: { at: number; label: string }[] = [];
  while (cursor.getTime() <= domain.endMs && ticks.length < 400) {
    const at = cursor.getTime();
    ticks.push({ at, label: cursor.getHours() === 0 || step >= 24 ? dayFormat.format(at) : hourFormat.format(at) });
    advance();
  }
  return ticks;
}

export function timeZoneLabel(startMs: number, endMs = startMs) {
  const format = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" });
  const zone = (at: number) => format.formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "Local time";
  const start = zone(startMs), end = zone(endMs);
  return start === end ? start : `${start} / ${end}`;
}
