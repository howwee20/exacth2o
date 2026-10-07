// The Applications embed is a static synthetic snapshot with no live feed. Its clock is the moment the
// snapshot was generated, so measurement ages read as of that moment instead of drifting to
// "Delayed" and then "Stale" while a visitor reads the page. (/demo has a live feed and a real clock.)
const snapshotAt = Date.now();

export function usePageClock(tickMs?: number) {
  void tickMs;
  return snapshotAt;
}
