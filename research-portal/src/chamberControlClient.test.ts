import { describe, expect, it } from "vitest";
import { gasMixerFunctionError } from "./gasMixerErrors";

describe("gas mixer Edge Function errors", () => {
  it("surfaces the server's actionable JSON message", async () => {
    const error = {
      context: new Response(
        JSON.stringify({ error: "The remote session is invalid or expired" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    };
    await expect(gasMixerFunctionError(error, "fallback")).resolves.toEqual(
      new Error("The remote session is invalid or expired"),
    );
  });

  it("replaces Supabase's generic non-2xx message", async () => {
    await expect(gasMixerFunctionError(
      new Error("Edge Function returned a non-2xx status code"),
      "Unable to renew the Gas Mixer session",
    )).resolves.toEqual(new Error("Unable to renew the Gas Mixer session"));
  });
});
