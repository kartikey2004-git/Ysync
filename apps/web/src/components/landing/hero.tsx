"use client";

import type { FormEvent } from "react";
import { ArrowRight } from "lucide-react";

const CURSORS = [
  { name: "Anya" },
  { name: "Marco" },
  { name: "Priya" },
];

function EditorMockup() {
  return (
    <div className="relative w-full max-w-[580px] select-none">
      <div className="overflow-hidden border border-neutral-200 bg-white shadow-[0_8px_40px_rgba(0,0,0,0.08)]">
        {/* toolbar */}
        <div className="flex items-center gap-1 border-b border-neutral-100 bg-neutral-50 px-4 py-2.5">
          {["B", "I", "U"].map((t) => (
            <button
              key={t}
              className="h-7 w-7 rounded text-xs font-semibold text-neutral-500 hover:bg-neutral-200"
            >
              {t}
            </button>
          ))}
          <div className="mx-2 h-4 w-px bg-neutral-200" />
          {["H1", "H2", "—"].map((t) => (
            <button
              key={t}
              className="h-7 rounded px-2 text-xs font-medium text-neutral-500 hover:bg-neutral-200"
            >
              {t}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            {CURSORS.map((c) => (
              <span
                key={c.name}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-800 text-[10px] font-bold text-white"
              >
                {c.name[0]}
              </span>
            ))}
          </div>
        </div>

        {/* document body */}
        <div className="relative px-10 py-8 text-[15px] leading-relaxed text-neutral-800">
          <p className="mb-1 text-2xl font-semibold tracking-tight text-black">
            Q3 Product Roadmap
          </p>

          <p className="mt-5 text-neutral-600">
            This quarter we're shipping offline-first sync for all document types. Every
            replica merges automatically the moment connection is restored,
            <span className="relative inline-block">
              <span className="bg-neutral-100 text-neutral-800"> no manual conflict resolution</span>
              <span className="absolute -top-5 -left-9 whitespace-nowrap rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {CURSORS[0].name}
              </span>
            </span>
            {" "}required.
          </p>

          <p className="mt-4 text-neutral-600">
            The CRDT engine handles concurrent edits from any number of
            collaborators.{" "}
            <span className="relative inline-block">
              <span className="bg-neutral-100 text-neutral-800">
                Each keystroke is addressable by origin
              </span>
              <span className="absolute top-5 left-0 whitespace-nowrap rounded-sm bg-neutral-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {CURSORS[1].name}
              </span>
            </span>
            {" "}so edits never collide.
          </p>

          <p className="mt-4 text-neutral-500">
            <span className="relative inline-block">
              <span className="bg-neutral-100 text-neutral-700">
                Go offline mid-sentence and keep writing
              </span>
              <span className="absolute -top-5 -left-9 whitespace-nowrap rounded-sm bg-neutral-400 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {CURSORS[2].name}
              </span>
            </span>
            your edits queue locally and sync automatically when you're back.
          </p>

          {/* blinking caret */}
          <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-neutral-800" />
        </div>

        {/* status bar */}
        <div className="flex items-center gap-4 border-t border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] text-neutral-400">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-neutral-800" />
            3 collaborators online
          </span>
          <span>•</span>
          <span>All changes saved</span>
          <span>•</span>
          <span>Offline-safe</span>
        </div>
      </div>

      {/* subtle glow under */}
      <div className="pointer-events-none absolute -bottom-6 left-1/2 h-16 w-3/4 -translate-x-1/2 rounded-full bg-neutral-200 blur-2xl" />
    </div>
  );
}

export function Hero({
  onCreateNew,
  slugInput,
  onSlugChange,
  onJoin,
}: {
  onCreateNew: () => void;
  slugInput: string;
  onSlugChange: (value: string) => void;
  onJoin: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="relative w-full overflow-hidden bg-white">
      <div className="mx-auto grid w-full max-w-[1400px] grid-cols-1 items-center gap-16 px-4 pt-32 pb-24 sm:px-6 lg:grid-cols-2 lg:gap-20 lg:px-10 lg:pt-40 lg:pb-32">
        {/* ── LEFT: copy + CTA ── */}
        <div className="flex flex-col items-start">
          <div className="mb-7">
            <span className="inline-flex items-center bg-neutral-100 px-5 py-2 text-[12px] font-medium uppercase tracking-[0.22em] text-neutral-700">
              Real-time collaborative editing
            </span>
          </div>

          <h1 className="text-[38px] font-medium leading-[1.02] tracking-[-0.03em] text-black sm:text-[48px] sm:leading-[0.96] sm:tracking-[-0.05em] md:text-[58px]">
            Write Together.
            <br />
            Never Lose a Word,{" "}
            <span className="text-neutral-500">Even Offline</span>.
          </h1>

          <p className="mt-7 max-w-lg text-[16px] leading-[1.5] text-[#666666] sm:text-[18px]">
            Create a document, share the link, and edit at the same time as
            anyone else. Go offline mid-sentence, your edits queue locally and
            merge automatically, with zero conflicts, the moment you&apos;re back.
          </p>

          <div className="mt-10 flex w-full max-w-lg flex-col border border-neutral-300 bg-white sm:flex-row sm:items-stretch">
            <button
              type="button"
              onClick={onCreateNew}
              className="flex h-13 shrink-0 items-center justify-center gap-2 bg-black px-8 text-[15px] font-medium text-white transition hover:bg-neutral-900 focus-visible:relative focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
            >
              Start a new document
              <ArrowRight className="h-4 w-4" />
            </button>

            <form
              onSubmit={onJoin}
              className="flex h-13 flex-1 items-stretch border-t border-neutral-300 sm:border-t-0 sm:border-l"
            >
              <input
                value={slugInput}
                onChange={(event) => onSlugChange(event.target.value)}
                placeholder="or enter an existing document id"
                className="min-w-0 flex-1 bg-transparent px-4 text-[15px] text-black placeholder:text-neutral-400 focus:outline-none"
              />
              <button
                type="submit"
                className="shrink-0 border-l border-neutral-300 px-6 text-[15px] font-medium text-black transition hover:bg-neutral-50 focus-visible:relative focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-black"
              >
                Join
              </button>
            </form>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-2 text-sm font-medium text-neutral-500">
            <span>CRDT-based</span>
            <span className="text-neutral-300">|</span>
            <span>Offline-first</span>
            <span className="text-neutral-300">|</span>
            <span>Zero-conflict merging</span>
            <span className="text-neutral-300">|</span>
            <span>Live cursors</span>
          </div>
        </div>

        {/* ── RIGHT: editor mockup ── */}
        <div className="flex items-center justify-center lg:justify-end">
          <EditorMockup />
        </div>
      </div>
    </section>
  );
}
