// LOCAL PREVIEW AND BROWSER TESTS ONLY. Never included in the public release.
// The clock is installed before the portal modules load, so every timer they set runs
// on it. ?speed=600 runs a simulated ten-hour, 100-pot calibration in about a minute.
import { installVirtualClock } from "./virtual-clock";

installVirtualClock(Number(new URLSearchParams(location.search).get("speed") ?? 1));
void import("./autocal-app");
