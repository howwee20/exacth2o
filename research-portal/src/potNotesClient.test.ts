import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ModuleKind, transpileModule } from "typescript";
import { sendPotNote, type NewPotNote } from "./potNotesClient";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("./supabase", async (importOriginal) => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://portal-notes-test.invalid");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "public-test-anon-key");
  const original = await importOriginal<typeof import("./supabase")>();
  // Exercise the actual immutable-client factory; only the shared mutable auth session is fake.
  return { ...original, supabase: { auth: { getSession } } };
});

const tokenA = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLWEiLCJleHAiOjQxMDI0NDQ4MDB9.signature";
const note: NewPotNote = {
  id: "11111111-1111-4111-8111-111111111111", project_id: "project-a", device_id: "controller-a",
  pairing_name: "Zone1-Pot1", research_pot_id: null, experiment_id: null, body: "Reseated sensor",
  tags: [], observed_at: "2026-10-08T15:00:00Z", author_label: "Account A", supersedes_id: null, client_context: {},
};
const stored = { ...note, created_by: "user-a", author_label: "Account A", recorded_at: "2026-10-08T15:01:00Z" };

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://portal-notes-test.invalid");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "public-test-anon-key");
  getSession.mockResolvedValue({ data: { session: { user: { id: "user-a" }, access_token: tokenA } }, error: null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("note writer identity", () => {
  it("uses the captured writer JWT for write and confirmation even if the shared account changes", async () => {
    const requests: { authorization: string | null; method: string }[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({ authorization: new Headers(init?.headers).get("Authorization"), method });
      if (method === "POST") {
        expect(JSON.parse(init?.body as string).created_by).toBe("user-a");
        // Another tab changes the shared auth session while the first response is in flight.
        getSession.mockResolvedValue({ data: { session: { user: { id: "user-b" }, access_token: "token-b" } }, error: null });
        return new Response(null, { status: 201 });
      }
      return new Response(JSON.stringify([stored]), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(sendPotNote(note, "user-a")).resolves.toMatchObject({ created_by: "user-a", body: note.body });
    expect(requests).toEqual([
      { authorization: `Bearer ${tokenA}`, method: "POST" },
      { authorization: `Bearer ${tokenA}`, method: "GET" },
    ]);
  });

  it("does not transmit a queued note when the current account is not its writer", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "user-b" }, access_token: "token-b" } }, error: null });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(sendPotNote(note, "user-a")).rejects.toMatchObject({ kind: "auth" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not accept a conflicting idempotent row as confirmation of this draft", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "POST"
      ? new Response(null, { status: 201 })
      : new Response(JSON.stringify([{ ...stored, body: "A different observation" }]), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(sendPotNote(note, "user-a")).rejects.toMatchObject({ kind: "rejected" });
  });

  it("keeps both offline demo writer factories on fixture clients even with a token", async () => {
    const fetch = vi.fn(() => { throw new Error("An offline demo attempted a network request"); });
    vi.stubGlobal("fetch", fetch);
    for (const relative of ["../../demo-preview/offline.ts", "../../applications-preview/offline.ts"]) {
      const path = new URL(relative, import.meta.url).pathname;
      // Demo sources are outside Vitest's served package. Execute their actual adapter module,
      // replacing only synthetic fixture dependencies; any network-client import is refused.
      const code = transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
      const adapter: any = {};
      runInNewContext(code, {
        exports: adapter, fetch, Date, Promise, Set, setInterval, clearInterval,
        require: (name: string) => {
          if (!name.endsWith("fixtures") && !name.endsWith("portalFixtures") && !name.endsWith("demoAggregates")) throw new Error(`Unexpected demo dependency: ${name}`);
          return { fixture: { data: { readings: [], pairings: [] } } };
        },
      });
      const writer = adapter.portalClientWithToken(tokenA);
      expect(writer).toBe(adapter.supabase);
      const result = await writer.from("portal_pot_notes").select("id");
      expect(result.error).toBeNull();
      expect(result.data).toEqual([]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
