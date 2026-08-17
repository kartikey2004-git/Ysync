// (counter, replicaId) pair globally unique hote hain aur replicas ke beech totally order bhi ho sakte hain — isi liye op id ke liye safe hain
export interface OpId {
  counter: number;
  replicaId: string;
}

// counter primary sort key hai; replicaId sirf tab kaam aata hai jab do concurrent ops ka counter same ho
export function compareOpId(a: OpId, b: OpId): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  if (a.replicaId === b.replicaId) return 0;
  return a.replicaId < b.replicaId ? -1 : 1;
}

export function opIdEquals(a: OpId | null, b: OpId | null): boolean {
  if (a === null || b === null) return a === b;
  return a.counter === b.counter && a.replicaId === b.replicaId;
}

export function opIdToString(id: OpId): string {
  return `${id.counter}@${id.replicaId}`;
}

export function opIdFromString(serialized: string): OpId {
  const at = serialized.lastIndexOf("@");
  return {
    counter: Number(serialized.slice(0, at)),
    replicaId: serialized.slice(at + 1),
  };
}
