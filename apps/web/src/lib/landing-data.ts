import type { LucideIcon } from "lucide-react";
import {
  CloudOff,
  FilePlus,
  GitMerge,
  History,
  RefreshCw,
  Share2,
  ShieldCheck,
  Users,
  WifiOff,
  Zap,
} from "lucide-react";

// Decorative sync-path lines rendered behind the hero, an abstract stand-in
// for edits travelling from a replica out to its peers.
export type Path = { d: string; transform: string };

export const PATHS: Path[] = [
  { d: "M367 405 C 367 300, 200 250, 130 60", transform: "" },
  { d: "M367 405 C 367 300, 320 220, 260 110", transform: "" },
  { d: "M367 405 C 367 300, 367 200, 367 40", transform: "" },
  { d: "M367 405 C 367 300, 414 220, 474 110", transform: "" },
  { d: "M367 405 C 367 300, 534 250, 604 60", transform: "" },
];

export type Faq = { question: string; answer: string };

export const faqs: Faq[] = [
  {
    question: "Do I need an account to start?",
    answer:
      "No signup. Click \"Start a new document\" and you're in a live, shareable document immediately.",
  },
  {
    question: "What happens if I lose my connection?",
    answer:
      "Keep typing. Your edits queue locally in the browser and sync automatically the moment you're back online, nothing is lost.",
  },
  {
    question: "How do conflicting edits get resolved?",
    answer:
      "YSync is built on a sequence CRDT (an RGA variant). Every edit is addressable by origin, not position, so concurrent edits from any number of collaborators always converge to the same document, no merge dialogs, no “keep mine or theirs.”",
  },
  {
    question: "How do I share a document?",
    answer:
      "Every document gets a short, unique id in its URL. Send that link to anyone and they join the same live document instantly.",
  },
  {
    question: "How many people can edit at once?",
    answer:
      "As many as join the link. Every collaborator gets a distinct color and a visible live cursor, so simultaneous edits never feel invisible.",
  },
  {
    question: "Is YSync open source?",
    answer: "Yes, the full source, including the CRDT engine, is on GitHub.",
  },
];

export type Step = {
  id: number;
  title: string;
  description: string;
  icon: LucideIcon;
  tags: string[];
  panelTitle: string;
  panelDescription: string;
};

export const steps: Step[] = [
  {
    id: 1,
    title: "You type",
    description: "Every keystroke applies to your local replica instantly.",
    icon: FilePlus,
    tags: ["Local-first", "Zero latency"],
    panelTitle: "Instant local apply",
    panelDescription:
      "Nothing waits on a round trip. Your edit lands in the document the moment you make it, online or off.",
  },
  {
    id: 2,
    title: "It queues if you're offline",
    description: "Lose connection mid-sentence and keep writing anyway.",
    icon: WifiOff,
    tags: ["Offline queue", "No data loss"],
    panelTitle: "Local queue",
    panelDescription:
      "Edits made while disconnected sit in a local queue, ordered and intact, ready to broadcast the moment you reconnect.",
  },
  {
    id: 3,
    title: "It broadcasts to peers",
    description: "Reconnect and every queued edit ships to the room.",
    icon: Share2,
    tags: ["Live sync", "Room broadcast"],
    panelTitle: "Broadcast",
    panelDescription:
      "The moment your connection returns, queued edits stream out to every other replica currently in the document.",
  },
  {
    id: 4,
    title: "It merges without conflict",
    description: "A sequence CRDT reconciles every replica's history.",
    icon: GitMerge,
    tags: ["CRDT", "RGA"],
    panelTitle: "CRDT merge",
    panelDescription:
      "An RGA variant keeps every edit addressable by origin, not position, so concurrent edits never collide, they interleave correctly.",
  },
  {
    id: 5,
    title: "Every replica converges",
    description: "All collaborators land on the exact same document.",
    icon: ShieldCheck,
    tags: ["Convergence", "Verified"],
    panelTitle: "Convergence",
    panelDescription:
      "Verified against thousands of simulated out-of-order, concurrent, and offline edits, every replica always reaches the same final state.",
  },
];

export type ChartStep = { label: string; value: number; featured?: boolean };

export const chartData: ChartStep[] = [
  { label: "Local edit", value: 15 },
  { label: "Queued", value: 38 },
  { label: "Broadcast", value: 64 },
  { label: "Merged", value: 88 },
  { label: "Converged", value: 100, featured: true },
];

export type Feature = {
  title: string;
  description: string;
  icon: LucideIcon;
  accent?: boolean;
};

export const leftFeatures: Feature[] = [
  {
    title: "Sequence CRDT",
    description:
      "An RGA variant keeps every replica's edit history addressable by origin, not position.",
    icon: GitMerge,
  },
  {
    title: "Local-first apply",
    description:
      "Every keystroke applies to your local replica instantly, no round trip to a server required.",
    icon: Zap,
  },
  {
    title: "Deterministic merge",
    description:
      "Concurrent edits from any number of replicas always converge to the same final document.",
    icon: RefreshCw,
  },
];

export const rightFeatures: Feature[] = [
  {
    title: "Offline queueing",
    description:
      "Lose connection mid-sentence and keep typing, edits queue locally until you're back.",
    icon: CloudOff,
  },
  {
    title: "Verified under load",
    description:
      "Tested against thousands of simulated out-of-order, concurrent, and offline edits.",
    icon: ShieldCheck,
  },
];

export type workflowStep = {
  title: string;
  description: string;
  icon: LucideIcon;
  border: string;
  bg: string;
};

export const workflowsteps: workflowStep[] = [
  {
    title: "Start a document",
    description:
      "No signup. Click once and you're in a live document with a short, shareable id.",
    icon: FilePlus,
    border: "border-neutral-300",
    bg: "from-neutral-50 to-neutral-100",
  },
  {
    title: "Share the link",
    description: "Anyone with the id joins the same document and starts typing immediately.",
    icon: Share2,
    border: "border-zinc-300",
    bg: "from-zinc-50 to-zinc-100",
  },
  {
    title: "Edit at the same time",
    description: "See who's there, watch cursors move, and keep writing together.",
    icon: Users,
    border: "border-stone-300",
    bg: "from-stone-50 to-stone-100",
  },
  {
    title: "Go offline anytime",
    description: "Keep typing with no connection, edits merge automatically when you're back.",
    icon: History,
    border: "border-slate-300",
    bg: "from-slate-50 to-slate-100",
  },
];
