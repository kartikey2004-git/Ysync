"use client";

import type { FormEvent } from "react";

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
    <section className="relative isolate w-full overflow-hidden bg-[#fafafa] py-16 sm:py-24 lg:py-32">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage: "radial-gradient(#d4d4d8 1px, transparent 1px)",
          backgroundSize: "12px 12px",
        }}
      />

      <div className="relative z-10 mx-auto w-full max-w-[1400px] px-4 sm:px-6 md:px-8 lg:px-10 xl:px-12">
        <div className="mb-6 flex justify-center sm:mb-7">
          <div className="border border-neutral-300 bg-neutral-100 px-3 py-1.5 text-center text-[9px] font-medium uppercase tracking-[0.2em] text-neutral-600 sm:text-[10px] sm:tracking-[0.25em]">
            Real-time collaborative editing
          </div>
        </div>

        <h1 className="mx-auto max-w-[900px] text-center text-[clamp(2rem,4vw,3.25rem)] font-semibold leading-[1.02] tracking-[-0.045em] text-black">
          <span className="block">Edit together, live.</span>
          <span className="block text-neutral-400">
            Offline edits merge on reconnect.
          </span>
        </h1>

        <p
          data-grid-avoid
          className="mx-auto mt-5 max-w-[640px] text-center text-[14px] leading-[1.55] text-neutral-600 sm:mt-6 sm:text-base"
        >
          Create a document, share the link, and edit together in real time.
          Keep writing offline, your changes stay local and merge automatically
          when you reconnect.
        </p>

        <div className="mx-auto mt-10 w-full max-w-[720px] sm:mt-12">
          <div className="flex w-full flex-col border border-black/15 bg-white p-1 sm:flex-row">
            <button
              type="button"
              onClick={onCreateNew}
              className="flex h-12 w-full shrink-0 items-center justify-center bg-black px-6 text-[13px] font-medium tracking-[-0.01em] text-white outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 sm:h-14 sm:w-auto sm:px-7 sm:text-sm lg:h-16"
            >
              Start a new document
            </button>

            <form
              onSubmit={onJoin}
              className="flex h-12 w-full min-w-0 items-center border-t border-black/10 bg-white sm:h-14 sm:flex-1 sm:border-t-0 lg:h-16"
            >
              <input
                value={slugInput}
                onChange={(event) => onSlugChange(event.target.value)}
                placeholder="Document ID"
                aria-label="Document ID"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent px-4 text-[13px] text-black outline-none placeholder:text-black/35 sm:px-5 sm:text-sm"
              />

              <button
                type="submit"
                disabled={slugInput.trim().length === 0}
                className="flex h-full shrink-0 items-center justify-center bg-transparent px-6 text-sm font-medium tracking-wide text-black outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black disabled:cursor-not-allowed disabled:opacity-30 sm:m-1 sm:px-6"
              >
                Join
              </button>
            </form>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-500 sm:mt-7 sm:gap-x-4 sm:text-[10px]">
          <span>CRDT-based</span>
          <span className="text-neutral-300">/</span>
          <span>Offline-first</span>
          <span className="text-neutral-300">/</span>
          <span>Conflict-free</span>
          <span className="text-neutral-300">/</span>
          <span>Live cursors</span>
        </div>
      </div>
    </section>
  );
}
