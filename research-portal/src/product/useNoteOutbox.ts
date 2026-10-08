import { useCallback, useEffect, useRef, useState } from "react";
import {
  dueEntries,
  inScope,
  newNoteId,
  newOutboxEntry,
  outboxStore,
  retryEntry,
  syncOutbox,
  type OutboxEntry,
  type SendOutcome,
} from "../noteOutbox";
import { NoteSendError, sendPotNote } from "../potNotesClient";

const channelName = "exacth2o-note-outbox";
const lockName = "exacth2o-note-outbox-send";
const pollMs = 15_000;

async function send(entry: OutboxEntry): Promise<SendOutcome> {
  try {
    const stored = await sendPotNote({
      id: entry.id,
      project_id: entry.projectId,
      device_id: entry.deviceId,
      pairing_name: entry.pairingName,
      research_pot_id: entry.researchPotId,
      experiment_id: entry.experimentId,
      body: entry.body,
      tags: entry.tags,
      observed_at: entry.observedAt,
      author_label: entry.authorLabel,
      supersedes_id: entry.supersedesId,
      client_context: { written_offline: entry.writtenOffline, attempts: entry.attempts + 1, client: "portal" },
    });
    return { kind: "sent", atIso: stored.recorded_at };
  } catch (error) {
    if (error instanceof NoteSendError) return { kind: error.kind, message: error.message } as SendOutcome;
    return { kind: "network", message: error instanceof Error ? error.message : "Network error" };
  }
}

export type NoteDraftInput = {
  deviceId: string;
  pairingName: string;
  researchPotId: string | null;
  experimentId: string | null;
  body: string;
  tags: string[];
  supersedesId?: string | null;
};

/**
 * The bench outbox for the signed-in account and project. Writes go to durable storage first,
 * then to the database when the connection and session allow; other tabs see the same queue.
 */
export function useNoteOutbox(scope: { userId: string; projectId: string; authorLabel: string } | null, options: { enabled: boolean }) {
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [syncing, setSyncing] = useState(false);
  const inFlight = useRef(false);
  // One channel per mounted hook, opened and closed by the same effect so a remount (or React's
  // development double-mount) never leaves a closed channel behind.
  const channelRef = useRef<BroadcastChannel | null>(null);
  const announce = useCallback(() => {
    try {
      channelRef.current?.postMessage("changed");
    } catch {
      // Other tabs pick the change up on their next poll.
    }
  }, []);
  const userId = scope?.userId ?? null;
  const projectId = scope?.projectId ?? null;

  const reload = useCallback(async () => {
    if (!userId || !projectId) {
      setEntries([]);
      return;
    }
    const store = await outboxStore();
    const all = await store.all();
    setEntries(all.filter((entry) => inScope(entry, userId, projectId)).sort((a, b) => b.observedAt.localeCompare(a.observedAt)));
  }, [projectId, userId]);

  const sync = useCallback(async () => {
    if (!userId || !projectId || !options.enabled || inFlight.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    inFlight.current = true;
    setSyncing(true);
    const run = async () => {
      const store = await outboxStore();
      const changed = await syncOutbox(store, { userId, projectId }, send);
      if (changed.length) announce();
    };
    try {
      const locks = (navigator as Navigator & { locks?: LockManager }).locks;
      if (locks?.request) await locks.request(lockName, { ifAvailable: true }, async (lock) => (lock ? run() : undefined));
      else await run();
    } finally {
      inFlight.current = false;
      setSyncing(false);
      await reload();
    }
  }, [announce, options.enabled, projectId, reload, userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return undefined;
    const channel = new BroadcastChannel(channelName);
    channelRef.current = channel;
    const onMessage = () => void reload();
    channel.addEventListener("message", onMessage);
    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [reload]);

  // The poll reads the latest queue through a ref so that reloading the queue never restarts the sync.
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    if (!options.enabled) return undefined;
    void sync();
    const onOnline = () => void sync();
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => {
      if (dueEntries(entriesRef.current).length) void sync();
    }, pollMs);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [options.enabled, sync]);

  const add = useCallback(async (input: NoteDraftInput) => {
    if (!scope) throw new Error("Sign in to write notes.");
    const entry = newOutboxEntry({
      id: newNoteId(),
      userId: scope.userId,
      projectId: scope.projectId,
      deviceId: input.deviceId,
      pairingName: input.pairingName,
      researchPotId: input.researchPotId,
      experimentId: input.experimentId,
      body: input.body,
      tags: input.tags,
      observedAt: new Date().toISOString(),
      authorLabel: scope.authorLabel,
      supersedesId: input.supersedesId ?? null,
      writtenOffline: typeof navigator !== "undefined" && navigator.onLine === false,
    });
    try {
      const store = await outboxStore();
      await store.put(entry);
    } catch {
      // Never pretend a note is safe: the composer keeps the text and shows this.
      throw new Error("This browser is not letting the portal keep notes on this device, so the note was not saved. Copy the text before leaving this page.");
    }
    announce();
    await reload();
    void sync();
    return entry;
  }, [announce, reload, scope, sync]);

  const retry = useCallback(async (id: string) => {
    const store = await outboxStore();
    const entry = (await store.all()).find((item) => item.id === id);
    if (!entry || !inScope(entry, userId, projectId)) return;
    await store.put(retryEntry(entry));
    announce();
    await reload();
    void sync();
  }, [announce, projectId, reload, sync, userId]);

  const discard = useCallback(async (id: string) => {
    const store = await outboxStore();
    const entry = (await store.all()).find((item) => item.id === id);
    if (!entry || !inScope(entry, userId, projectId) || entry.state === "sent") return;
    await store.remove(id);
    announce();
    await reload();
  }, [announce, projectId, reload, userId]);

  const waiting = entries.filter((entry) => entry.state !== "sent");
  return {
    entries,
    waiting,
    failed: entries.filter((entry) => entry.state === "failed"),
    needsSignIn: entries.some((entry) => entry.needsSignIn && entry.state === "pending"),
    syncing,
    add,
    retry,
    discard,
    sync,
  };
}
