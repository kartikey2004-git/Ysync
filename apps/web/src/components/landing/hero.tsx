"use client";

import type { FormEvent } from "react";
import { ArrowRight } from "lucide-react";

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
    <section className="relative w-full overflow-hidden bg-white mt-60">
      <div className="relative z-10  w-full px-4 text-center sm:px-6 lg:px-10">
        <div className="w-full text-center">
          <div className="mb-7">
            <span className="inline-flex items-center bg-neutral-100 px-5 py-2 text-[12px] font-medium uppercase tracking-[0.22em] text-neutral-700">
              Real-time collaborative editing
            </span>
          </div>

          <h1 className="mx-auto max-w-[1100px] text-[38px] font-medium leading-[1.02] tracking-[-0.03em] text-black sm:text-[52px] sm:leading-[0.96] sm:tracking-[-0.06em] md:text-[66px]">
            Write Together.
            <br />
            Never Lose a Word,
            <br />
            Even <span className="text-neutral-500">Offline</span>.
          </h1>

          <p className="mx-auto mt-7 max-w-190 text-[16px] leading-[1.4] text-[#666666] sm:text-[18px] sm:leading-[1.3] md:text-[20px]">
            Create a document, share the link, and edit at the same time as
            anyone else. Go offline mid-sentence, your edits queue locally
            and merge automatically, with zero conflicts, the moment
            you&apos;re back.
          </p>

          <div className="mx-auto mt-12 flex w-full max-w-xl flex-col border border-neutral-300 bg-white sm:flex-row sm:items-stretch">
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

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-sm font-medium text-neutral-600">
            <span>CRDT-based |</span>
            <span>Offline-first |</span>
            <span>Zero-conflict merging |</span>
            <span>Live cursors</span>
          </div>
        </div>
      </div>
    </section>
  );
}
