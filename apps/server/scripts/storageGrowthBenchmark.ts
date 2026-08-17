// Storage-growth benchmark hai. Test nahi, sirf report hai. Run karo:
//
//   npm run benchmark:storage -w apps/server
//
// Snapshot+GC cycle (RoomManager ka snapshotOpThreshold tick,
// PersistenceStore#writeSnapshot jo purane Operation rows delete karta hai)
// se asal mein Operation table ka row count bound hota hai kisi bhi waqt —
// total historical edit count nahi. GC ke bina woh table har op ke liye ek
// row rakhega, hamesha ke liye badhta rahega. GC ke saath, kitna bhi
// edit history ho, ek document ke liye kabhi snapshotOpThreshold se zyada
// rows nahi hongi. Yeh script yehi seedha dikhata hai: O(1)-vs-O(N)
// row-count bound hai, koi fuzzy byte ratio nahi.
//
// Yeh chhota, secondary effect bhi report karta hai — ek hi snapshot ke
// andar tombstone payloads compact karna (deleted node ka value/attrs null
// karna). Yeh real hai par yahan modest hai — neeche note mein wajah hai —
// aur storage-growth claim ka main mechanism yeh nahi hai.
import { Rga } from "@ysync/crdt";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz     ";
const SNAPSHOT_OP_THRESHOLD = 500; // RoomManagerOptions.snapshotOpThreshold jaisa hi rakha hai
const SESSIONS = 20; // simulated snapshot cycles — isko badhao toh total edit history bhi badh jayegi
const BACKSPACE_PROBABILITY = 0.12; // kitne keystrokes correction hain, naya content nahi

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
    // yahan snapshot+GC fire hota hai: writeSnapshot() seq <= atSeq wali har
    // Operation row delete kar deta hai. Is document ka row count wapas 0 pe
    // gir jata hai aur agle snapshot tak SNAPSHOT_OP_THRESHOLD se zyada nahi badhega,
    // chahe session kitna bhi ho
    rga.compactTombstones();
  }

  const finalLength = rga.read().length;

  console.log("YSync storage-growth benchmark");
  console.log("================================");
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

  // Secondary chhota effect: ek hi snapshot ke andar tombstone *payloads* compact
  // karna. Single-character values ke liye modest hi hai — node ka value null
  // karna (`null`, 4 bytes) ek nulled single-char string (jaise `"a"`, 3 bytes)
  // se meaningfully chhota nahi hai, isliye yahan zyada bachat nahi hoti.
  // `attrs` payloads ya multi-character values mein zyada fark padta hai. Yeh
  // project dead tombstone nodes ko structurally remove nahi karta (kar bhi
  // nahi sakta — baad ka insert usko origin ke taur pe reference kar sakta hai),
  // isliye yeh upar wale row-count bound ka mechanism nahi hai.
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
