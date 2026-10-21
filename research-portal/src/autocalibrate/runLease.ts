/** A renewal of a run's hold failed; `lost` when another screen now holds the run (not a network error). */
export class RunLeaseError extends Error {
  constructor(message: string, readonly lost: boolean) {
    super(message);
  }
}
