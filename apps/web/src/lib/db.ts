import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Op, RgaSnapshotNode } from "@ysync/crdt";

export interface DocumentRecord {
  docId: string;
  lastAckedSeq: number;
  snapshotState: RgaSnapshotNode[];
}

export interface OutboxRecord {
  docId: string;
  opId: string;
  op: Op;
  createdAt: number;
}

export interface ReplicaRecord {
  docId: string;
  replicaId: string;
  name: string;
  color: string;
}

interface YSyncDB extends DBSchema {
  documents: {
    key: string;
    value: DocumentRecord;
  };
  outbox: {
    key: [string, string];
    value: OutboxRecord;
    indexes: { byDoc: string };
  };
  replica: {
    key: string;
    value: ReplicaRecord;
  };
}

const DB_NAME = "ysync";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<YSyncDB>> | null = null;

// Lazy rakha hai — indexedDB ko sirf tab touch karta hai jab client-side code
// se actually call ho, module load hote hi nahi — isliye SSR mein yeh file
// import karna bhi safe hai, koi error nahi aayega.
function getDb(): Promise<IDBPDatabase<YSyncDB>> {
  dbPromise ??= openDB<YSyncDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore("documents", { keyPath: "docId" });
      const outbox = db.createObjectStore("outbox", { keyPath: ["docId", "opId"] });
      outbox.createIndex("byDoc", "docId");
      db.createObjectStore("replica", { keyPath: "docId" });
    },
  });
  return dbPromise;
}

export async function loadDocumentRecord(docId: string): Promise<DocumentRecord | undefined> {
  const db = await getDb();
  return db.get("documents", docId);
}

export async function saveDocumentRecord(record: DocumentRecord): Promise<void> {
  const db = await getDb();
  await db.put("documents", record);
}

export async function listOutbox(docId: string): Promise<OutboxRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex("outbox", "byDoc", docId);
}

export async function addToOutbox(record: OutboxRecord): Promise<void> {
  const db = await getDb();
  await db.put("outbox", record);
}

export async function removeFromOutbox(docId: string, opId: string): Promise<void> {
  const db = await getDb();
  await db.delete("outbox", [docId, opId]);
}

const NAMES = ["Otter", "Falcon", "Panda", "Lynx", "Heron", "Badger", "Osprey", "Marten"];
const COLORS = ["#e63946", "#2a9d8f", "#e9c46a", "#457b9d", "#f4a261", "#8338ec", "#06d6a0", "#ef476f"];

function randomFrom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

export async function getOrCreateReplica(docId: string): Promise<ReplicaRecord> {
  const db = await getDb();
  // pehle se replica record hai toh wahi use karo — har reload pe naya replicaId nahi banana,
  // warna server iska history purane replicaId se disconnect samajh lega
  const existing = await db.get("replica", docId);
  if (existing) return existing;

  const created: ReplicaRecord = {
    docId,
    replicaId: crypto.randomUUID(),
    name: `${randomFrom(NAMES)}-${Math.floor(Math.random() * 1000)}`,
    color: randomFrom(COLORS),
  };
  await db.put("replica", created);
  return created;
}
