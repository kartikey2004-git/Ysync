"use client";

import { workflowStep, workflowsteps } from "@/lib/landing-data";

export function WorkFlow() {
  return (
    <section className="relative w-full overflow-hidden bg-[#fafafa] py-20 sm:py-24 lg:py-28">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "radial-gradient(#d4d4d8 1px, transparent 1px)",
          backgroundSize: "12px 12px",
        }}
      />

      <div className="relative z-10 mx-auto w-full max-w-[1400px] px-4 sm:px-6 md:px-8 lg:px-10 xl:px-12">
        <div className="mb-6 flex justify-center sm:mb-7">
          <div className="border border-neutral-300 bg-neutral-100 px-3 py-1.5 text-center text-[9px] font-medium uppercase tracking-[0.2em] text-neutral-600 sm:text-[10px] sm:tracking-[0.25em]">
            From blank page to live document
          </div>
        </div>

        <h2 className="mx-auto max-w-[900px] text-center text-[1.125rem] font-medium leading-[1.25] sm:text-[clamp(2rem,3.6vw,3rem)] sm:leading-[1.05] tracking-[-0.045em] text-black">
          <span className="block whitespace-nowrap sm:whitespace-normal">Start a document. Share the link.</span>
          <span className="mt-2 block sm:mt-3">
            Write together, even offline.
          </span>
        </h2>

        <p className="mx-auto mt-4 max-w-[680px] text-center text-[14px] leading-[1.55] text-neutral-600 sm:text-base">
          Every keystroke you and your collaborators make gets merged into one
          consistent document automatically, even across offline stretches.
        </p>

        <div className="mt-10 grid grid-cols-1 gap-3 sm:mt-12 sm:grid-cols-2 lg:mt-14 lg:grid-cols-4">
          {workflowsteps.map((step: workflowStep) => {
            const Icon = step.icon;

            return (
              <div
                key={step.title}
                className={`
          relative
          flex
          min-h-[210px]
          flex-col
          justify-between
          overflow-hidden
          bg-white
          p-5
          sm:min-h-[220px]
          sm:p-6
        `}
              >
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0"
                >
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,0.08),transparent_50%)]" />

                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_50%,rgba(255,255,255,0.05),transparent_40%)]" />

                  <div className="absolute inset-0 bg-gradient-to-br from-white/[0.06] via-transparent to-transparent blur-2xl" />
                </div>

                <Icon
                  size={18}
                  strokeWidth={1.5}
                  className="relative z-10 shrink-0 text-black"
                />

                <div className="relative z-10 mt-10">
                  <h3 className="text-base font-medium tracking-tight text-black sm:text-lg">
                    {step.title}
                  </h3>

                  <p className="mt-2 max-w-[32ch] text-[13px] leading-[1.55] text-black/60 sm:text-sm">
                    {step.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}