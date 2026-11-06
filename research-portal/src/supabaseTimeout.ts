type AbortableRequest<T> = PromiseLike<T> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<T>;
};

export async function withSupabaseTimeout<T>(
  request: AbortableRequest<T> | ((signal: AbortSignal) => PromiseLike<T>),
  timeoutMs: number,
  label: string,
  /** Cancels the request in flight, e.g. when the reader no longer needs it. */
  signal?: AbortSignal,
): Promise<T> {
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel);
  if (signal?.aborted) cancel();
  try {
    const pending = typeof request === "function"
      ? request(controller.signal)
      : typeof request.abortSignal === "function"
        ? request.abortSignal(controller.signal)
        : request;
    return await Promise.race([
      Promise.resolve(pending),
      new Promise<T>((_, reject) => {
        timeoutId = globalThis.setTimeout(() => {
          reject(new Error(`${label} timed out`));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId != null) globalThis.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", cancel);
  }
}
