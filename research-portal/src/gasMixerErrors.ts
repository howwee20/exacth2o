export async function gasMixerFunctionError(
  error: unknown,
  fallback: string,
) {
  if (error && typeof error === "object" && "context" in error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        const body = await context.clone().json() as { error?: unknown };
        if (typeof body.error === "string" && body.error.trim()) {
          return new Error(body.error);
        }
      } catch {
        // Fall through to the local message when the response has no JSON body.
      }
    }
  }
  if (error instanceof Error && error.message && !/non-2xx status code/i.test(error.message)) {
    return error;
  }
  return new Error(fallback);
}
