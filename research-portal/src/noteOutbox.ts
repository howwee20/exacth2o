/**
 * Durable outbox for notes written at the bench.
 *
 * - Every note gets a stable id on the device that wrote it, so sending it twice can never
 *   create two notes (the database ignores a repeated id).
 * - Entries are scoped to (user, project). A different account on the same device never sees,
 *   sends or counts another account's notes; they stay until that account signs in again.
 * - States are explicit: pending (waiting to send), sending, failed (the server refused it, with
 *   the reason; never retried automatically), sent (kept briefly so the screen can confirm it).
 * - The time the person wrote the note is kept as written; the server records when it arrived.
 * - Storage is IndexedDB, with localStorage as the fallback when IndexedDB is unavailable.
 */

export type OutboxState = "pending" | "sending" | "failed" | "sent";

export type OutboxEntry = {
  id: string;
  userId: string;
  projectId: string;
  deviceId: string;
  pairingName: string;
  researchPotId: string | null;
  experimentId: string | null;
  body: string;
  tags: string[];
  /** When the person wrote it, from the device clock (ISO). */
  observedAt: string;
  authorLabel: string;
  supersedesId: string | null;
  /** The device reported no connection when the note was written. */
  writtenOffline: boolean;
  state: OutboxState;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  /** Set when a send was refused because the session ended; cleared on the next attempt. */
  needsSignIn: boolean;
  sentAt: string | null;
  createdAt: string;
};

export const outboxRetentionMs = 7 * 24 * 60 * 60_000;
const maxBackoffMs = 5 * 60_000;

export function newOutboxEntry(input: Omit<OutboxEntry, "state" | "attempts" | "lastError" | "lastAttemptAt" | "needsSignIn" | "sentAt" | "createdAt">, nowMs = Date.now()): OutboxEntry {
  return {
    ...input,
    body: input.body.trim(),
    state: "pending",
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    needsSignIn: false,
    sentAt: null,
    createdAt: new Date(nowMs).toISOString(),
  };
}

export function inScope(entry: OutboxEntry, userId: string | null | undefined, projectId: string | null | undefined) {
  return Boolean(userId && projectId) && entry.userId === userId && entry.projectId === projectId;
}

/** Wait before retrying after a network failure: 5 s, 10 s, 20 s, … at most 5 min. */
export function retryDelayMs(attempts: number) {
  return Math.min(maxBackoffMs, 5_000 * 2 ** Math.max(0, attempts - 1));
}

/** Entries to send now, oldest first. Failed (refused) entries are only sent when retried by hand. */
export function dueEntries(entries: readonly OutboxEntry[], nowMs = Date.now()) {
  return entries
    .filter((entry) => {
      if (entry.state === "sending") {
        // A send interrupted by a reload or a closed tab is retried after a pause.
        const last = entry.lastAttemptAt ? Date.parse(entry.lastAttemptAt) : 0;
        return nowMs - last > 30_000;
      }
      if (entry.state !== "pending") return false;
      if (!entry.lastAttemptAt || entry.needsSignIn) return true;
      return nowMs - Date.parse(entry.lastAttemptAt) >= retryDelayMs(entry.attempts);
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export type SendOutcome =
  | { kind: "sent"; atIso: string }
  | { kind: "network"; message: string }
  | { kind: "auth"; message: string }
  | { kind: "rejected"; message: string };

export function afterAttempt(entry: OutboxEntry, outcome: SendOutcome, nowIso = new Date().toISOString()): OutboxEntry {
  const attempted = { ...entry, attempts: entry.attempts + 1, lastAttemptAt: nowIso };
  switch (outcome.kind) {
    case "sent":
      return { ...attempted, state: "sent", sentAt: outcome.atIso, lastError: null, needsSignIn: false };
    case "network":
      return { ...attempted, state: "pending", lastError: outcome.message, needsSignIn: false };
    case "auth":
      return { ...attempted, state: "pending", lastError: "Sign in again to send this note.", needsSignIn: true };
    case "rejected":
      return { ...attempted, state: "failed", lastError: outcome.message, needsSignIn: false };
  }
}

export function retryEntry(entry: OutboxEntry): OutboxEntry {
  return { ...entry, state: "pending", lastAttemptAt: null, needsSignIn: false };
}

/** Sent entries older than the retention window are dropped; nothing unsent ever is. */
export function prunable(entry: OutboxEntry, nowMs = Date.now()) {
  return entry.state === "sent" && entry.sentAt != null && nowMs - Date.parse(entry.sentAt) > outboxRetentionMs;
}

// ---------------------------------------------------------------- storage

export type OutboxStore = {
  all(): Promise<OutboxEntry[]>;
  put(entry: OutboxEntry): Promise<void>;
  remove(id: string): Promise<void>;
};

const dbName = "exacth2o-portal";
const storeName = "pot-note-outbox";
const fallbackKey = "exacth2o.portal.noteOutbox.v1";

function idbRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function indexedDbStore(): OutboxStore {
  let opening: Promise<IDBDatabase> | null = null;
  const db = () => (opening ??= openDatabase());
  const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
    const database = await db();
    const transaction = database.transaction(storeName, mode);
    const result = await idbRequest(action(transaction.objectStore(storeName)));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return result;
  };
  return {
    all: () => run("readonly", (store) => store.getAll() as IDBRequest<OutboxEntry[]>),
    put: async (entry) => {
      await run("readwrite", (store) => store.put(entry));
    },
    remove: async (id) => {
      await run("readwrite", (store) => store.delete(id));
    },
  };
}

function localStorageStore(): OutboxStore {
  const read = (): OutboxEntry[] => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(fallbackKey) ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const write = (entries: OutboxEntry[]) => window.localStorage.setItem(fallbackKey, JSON.stringify(entries));
  return {
    all: async () => read(),
    put: async (entry) => write([...read().filter((item) => item.id !== entry.id), entry]),
    remove: async (id) => write(read().filter((item) => item.id !== id)),
  };
}

export function memoryStore(initial: OutboxEntry[] = []): OutboxStore {
  const entries = new Map(initial.map((entry) => [entry.id, entry]));
  return {
    all: async () => Array.from(entries.values()),
    put: async (entry) => {
      entries.set(entry.id, entry);
    },
    remove: async (id) => {
      entries.delete(id);
    },
  };
}

let defaultStore: OutboxStore | null = null;

/** IndexedDB when it opens, otherwise localStorage; decided once per page. */
export async function outboxStore(): Promise<OutboxStore> {
  if (defaultStore) return defaultStore;
  if (typeof indexedDB !== "undefined") {
    try {
      const candidate = indexedDbStore();
      await candidate.all();
      defaultStore = candidate;
      return candidate;
    } catch {
      // Private browsing or a blocked database: fall through to localStorage.
    }
  }
  defaultStore = localStorageStore();
  return defaultStore;
}

// ---------------------------------------------------------------- sync

export type Sender = (entry: OutboxEntry) => Promise<SendOutcome>;

/**
 * Send every due entry in scope, one at a time, oldest first. Stops at the first sign-in or
 * network failure (the rest would fail the same way). Returns the entries it changed.
 */
export async function syncOutbox(store: OutboxStore, scope: { userId: string; projectId: string }, send: Sender, nowMs = Date.now(), isCurrent = () => true) {
  const all = await store.all();
  if (!isCurrent()) return [];
  for (const entry of all) if (prunable(entry, nowMs)) await store.remove(entry.id);
  const due = dueEntries(all.filter((entry) => inScope(entry, scope.userId, scope.projectId)), nowMs);
  const changed: OutboxEntry[] = [];
  for (const entry of due) {
    if (!isCurrent()) break;
    const sending: OutboxEntry = { ...entry, state: "sending", lastAttemptAt: new Date(nowMs).toISOString() };
    await store.put(sending);
    if (!isCurrent()) break;
    const outcome = await send(sending);
    const next = afterAttempt(entry, outcome);
    await store.put(next);
    changed.push(next);
    if (outcome.kind === "network" || outcome.kind === "auth") break;
  }
  return changed;
}

/** A random RFC 4122 v4 id (crypto.randomUUID where available). */
export function newNoteId() {
  const source = globalThis.crypto;
  if (typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------- drafts

const draftPrefix = "exacth2o.portal.noteDraft.v2";

export function draftKey(userId: string, projectId: string, deviceId: string, pairingName: string, supersedesId: string | null = null) {
  return `${draftPrefix}:${JSON.stringify([userId, projectId, deviceId, pairingName, supersedesId])}`;
}

export function loadDraft(key: string): { body: string; tags: string[] } | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null");
    return parsed && typeof parsed.body === "string" ? { body: parsed.body, tags: Array.isArray(parsed.tags) ? parsed.tags : [] } : null;
  } catch {
    return null;
  }
}

export function saveDraft(key: string, draft: { body: string; tags: string[] }) {
  try {
    if (!draft.body.trim() && !draft.tags.length) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage full or blocked: the text stays in the form.
  }
}
