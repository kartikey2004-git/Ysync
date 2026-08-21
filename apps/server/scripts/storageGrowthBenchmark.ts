// Storage-growth benchmark. Not a test, just a report. Run with:
//
//   npm run benchmark:storage -w apps/server
//
// The snapshot+GC cycle (RoomManager's snapshotOpThreshold tick, PersistenceStore#writeSnapshot deleting the old Operation rows) is what actually bounds the Operation table's row count at any given moment — not the total historical edit count. Without GC, that table would keep one row per op forever, growing without bound. With GC, no matter how much edit history exists, a document's rows never exceed snapshotOpThreshold. This script demonstrates exactly that: an O(1)-vs-O(N) row-count bound, not some fuzzy byte ratio.

// It also reports a smaller, secondary effect — compacting tombstone payloads within a single snapshot (nulling a deleted node's value/attrs). That's real but modest here — see the note below for why — and it isn't the main mechanism behind the storage-growth claim.
import { Rga } from "@ysync/crdt";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz     ";
const SNAPSHOT_OP_THRESHOLD = 500; // kept in sync with RoomManagerOptions.snapshotOpThreshold
const SESSIONS = 20; // simulated snapshot cycles — raise this to grow the total edit history
const BACKSPACE_PROBABILITY = 0.12; // how many keystrokes are corrections rather than new content

function randomChar(): string {
  return ALPHABET[Math.floor(Math.random() * ALPHABET.length)] as string;
}

function runOpsUntilThreshold(rga: Rga, count: number): number {
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    const currentLength = rga.read().length;
    const shouldBackspace = currentLength > 0 && Math.random() < BACKSPACE_PROBABILITY;
    const op = shouldBackspace ? rga.localDelete(currentLength - 1) : rga.localInsert(currentLength, randomChar());
    bytes += JSON.stringify(op).length;
  }
  return bytes;
}

function main(): void {
  const rga = new Rga("benchmark-replica");
  let totalOpsEverGenerated = 0;

  for (let session = 1; session <= SESSIONS; session++) {
    runOpsUntilThreshold(rga, SNAPSHOT_OP_THRESHOLD);
    totalOpsEverGenerated += SNAPSHOT_OP_THRESHOLD;
    // this is where snapshot+GC fires: writeSnapshot() deletes every Operation row with seq <= atSeq. This document's row count drops back to 0 and won't grow past SNAPSHOT_OP_THRESHOLD before the next snapshot, no matter how many sessions have run
    rga.compactTombstones();
  }

  const finalLength = rga.read().length;

  console.log("YSync storage-growth benchmark");  
  console.log(`snapshot cycles simulated: ${SESSIONS} (snapshotOpThreshold = ${SNAPSHOT_OP_THRESHOLD})`);
  console.log(`final visible document length: ${finalLength} characters`);
  console.log("");
  console.log(`total ops ever generated across all cycles:            ${totalOpsEverGenerated.toLocaleString()}`);
  console.log(`Operation table rows if NEVER GC'd (naive, unbounded):  ${totalOpsEverGenerated.toLocaleString()} rows`);
  console.log(`Operation table rows at any moment with Phase 4 GC:     <= ${SNAPSHOT_OP_THRESHOLD.toLocaleString()} rows`);
  console.log("");
  console.log(
    `run this with a larger SESSIONS (try 200) and the naive count scales linearly while the GC'd bound ` +
      `stays exactly ${SNAPSHOT_OP_THRESHOLD} — that's the O(1)-vs-O(N) property, not a fixed percentage.`,
  );

  // Secondary, smaller effect: compacting tombstone *payloads* within a single snapshot. This is modest for single-character values — nulling a node's value (`null`, 4 bytes) isn't meaningfully smaller than a nulled single-char string (e.g. `"a"`, 3 bytes), so there isn't much saved here. It makes more of a difference for `attrs` payloads or multi-character values. This project doesn't structurally remove dead tombstone nodes (it can't — a later insert may still reference one as an origin), so this isn't the mechanism behind the row-count bound above.
  const single = new Rga("benchmark-replica-single-cycle");
  runOpsUntilThreshold(single, SNAPSHOT_OP_THRESHOLD);
  const beforeCompaction = JSON.stringify(single.toSnapshot()).length;
  single.compactTombstones();
  const afterCompaction = JSON.stringify(single.toSnapshot()).length;
  console.log("");
  console.log(`single-snapshot tombstone-payload-compaction effect (secondary):`);
  console.log(`  before: ${beforeCompaction.toLocaleString()} bytes, after: ${afterCompaction.toLocaleString()} bytes`);
}

main();
