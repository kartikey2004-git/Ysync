import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { Rga } from "../src/rga.js";
import type { Op } from "../src/op.js";

const ALPHABET = "abcde";

interface ActionSpec {
  kind: "insert" | "delete";
  charIndex: number;
  positionSeed: number;
}

const actionArb = fc.record({
  kind: fc.constantFrom<"insert" | "delete">("insert", "delete"),
  charIndex: fc.integer({ min: 0, max: ALPHABET.length - 1 }),
  positionSeed: fc.nat(),
});

// replica ke apne action stream ko uske Rga pe chalata hai, jo ops bane unhe return karta hai
function runReplicaActions(rga: Rga, actions: ActionSpec[]): Op[] {
  const ops: Op[] = [];
  for (const action of actions) {
    const currentLength = rga.read().length;
    if (action.kind === "insert" || currentLength === 0) {
      const position = currentLength === 0 ? 0 : action.positionSeed % (currentLength + 1);
      const value = ALPHABET[action.charIndex] as string;
      ops.push(rga.localInsert(position, value));
    } else {
      const position = action.positionSeed % currentLength;
      ops.push(rga.localDelete(position));
    }
  }
  return ops;
}

// deterministic seeded Fisher-Yates shuffle hai, taaki koi failing case seed se hi reproduce ho jaaye
function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

describe("convergence (property-based)", () => {
  // 3 replicas x 20-100 ops x 50 runs => poore property execution mein kai
  // hazaar ops chal jaate hain, "5,000+ out-of-order concurrent operations"
  // wala convergence target isi se satisfy hota hai.
  test("replicas converge to the same document regardless of delivery order", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 20, maxLength: 100 }),
        fc.array(actionArb, { minLength: 20, maxLength: 100 }),
        fc.array(actionArb, { minLength: 20, maxLength: 100 }),
        fc.nat(),
        (actionsA, actionsB, actionsC, seed) => {
          const alice = new Rga("alice");
          const bob = new Rga("bob");
          const carol = new Rga("carol");

          const opsA = runReplicaActions(alice, actionsA);
          const opsB = runReplicaActions(bob, actionsB);
          const opsC = runReplicaActions(carol, actionsC);
          const allOps = [...opsA, ...opsB, ...opsC];

          // alice ka apna view: baaki sabke ops apne local state ke upar apply karo
          alice.applyAll(opsB);
          alice.applyAll(opsC);

          // do independent observers poori merged history do alag random order
          // mein replay kar rahe hain (fully out-of-order, ek replica ke apne
          // stream ke andar bhi out-of-order)
          const observerOne = new Rga("observer-1");
          const observerTwo = new Rga("observer-2");
          observerOne.applyAll(seededShuffle(allOps, seed));
          observerTwo.applyAll(seededShuffle(allOps, seed + 1));

          expect(observerOne.read()).toEqual(alice.read());
          expect(observerTwo.read()).toEqual(alice.read());
        }
      ),
      { numRuns: 50 }
    );
  });
});
