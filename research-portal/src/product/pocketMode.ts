const atBenchKey = "exacth2o.portal.atBench.v1";

/** Whether this device opens the portal "At the bench" (a remembered, per-device choice). */
export function atBenchRemembered() {
  try {
    return window.localStorage.getItem(atBenchKey) === "1";
  } catch {
    return false;
  }
}

export function rememberAtBench(on: boolean) {
  try {
    if (on) window.localStorage.setItem(atBenchKey, "1");
    else window.localStorage.removeItem(atBenchKey);
  } catch {
    // The mode then simply is not remembered.
  }
}
