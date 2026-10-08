import { chartData, ChartStep } from "@/lib/landing-data";

export default function ReplyRateSection() {
  return (
    <section className="relative overflow-hidden bg-[#fafafa] py-12 sm:py-16 lg:py-24">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "radial-gradient(circle,#d4d4d4 1px,transparent 1px)",
          backgroundSize: "16px 16px",
        }}
      />

      <div className="relative w-full border border-zinc-200 bg-[#f8f8f8] p-5 sm:p-8 md:p-12 lg:p-16 xl:p-20">
        <div className="max-w-5xl">
          <div className="inline-flex items-center bg-neutral-100 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-neutral-700 sm:text-xs sm:tracking-[0.2em]">
            • ONE DOCUMENT. ZERO CONFLICTS.
          </div>

          <h2 className="mt-5 max-w-4xl text-[clamp(2rem,5vw,3.75rem)] font-medium leading-[1.05] tracking-[-0.04em] text-black">
            Every Replica Converges, By Design.
          </h2>

          <p className="mt-5 max-w-5xl text-sm leading-6 text-zinc-600 sm:text-base sm:leading-7">
            YSync&rsquo;s sync engine is a sequence CRDT, an RGA variant that
            keeps every replica&rsquo;s history addressable by origin, not
            position, verified against thousands of simulated out-of-order,
            concurrent, offline edits.
          </p>

          <p className="mt-4 max-w-4xl text-sm leading-6 text-zinc-700 sm:text-base sm:leading-7">
            The difference: your edits stay connected from the first keystroke
            to the final, converged document.
          </p>
        </div>

        <div className="mt-10 grid gap-10 sm:mt-12 lg:mt-14 lg:grid-cols-[1.5fr_0.9fr] lg:gap-12">
          <ConvergenceChart />
          <ConvergenceNote />
        </div>
      </div>
    </section>
  );
}

function ConvergenceChart() {
  const maxValue = 100;

  return (
    <div className="relative min-w-0">
      <div className="mb-7 text-center font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-600 sm:text-xs">
        Path to a Converged Document
      </div>

      <div className="relative h-[300px] pl-10 sm:h-[340px] sm:pl-12 lg:h-[400px]">
        <div className="relative h-full border-l border-b border-zinc-300">
          {[0, 20, 40, 60, 80, 100].map((tick) => (
            <div
              key={tick}
              className="absolute left-0 right-0 border-t border-dashed border-zinc-200"
              style={{
                bottom: `${(tick / maxValue) * 100}%`,
              }}
            >
              <span className="absolute right-full mr-2 -translate-y-1/2 whitespace-nowrap text-[10px] text-zinc-500 sm:text-xs">
                {tick}%
              </span>
            </div>
          ))}

          <div className="absolute inset-0 flex items-end justify-around gap-2 px-3 sm:px-6">
            {chartData.map((item: ChartStep) => (
              <div
                key={item.label}
                className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
              >
                <div
                  className="relative w-full max-w-[56px] border border-zinc-300 sm:max-w-[68px] lg:max-w-[80px]"
                  style={{
                    height: `${(item.value / maxValue) * 100}%`,
                  }}
                >
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 opacity-60"
                    style={{
                      background:
                        "repeating-linear-gradient(135deg,#ddd,#ddd 2px,transparent 2px,transparent 6px)",
                    }}
                  />

                  <div className="absolute left-2 top-2 z-10 text-[10px] text-zinc-700 sm:text-xs">
                    {item.value}%
                  </div>
                </div>

                <div className="mt-3 max-w-[70px] text-center font-mono text-[9px] uppercase leading-3 tracking-[0.08em] text-zinc-600 sm:mt-4 sm:text-[10px] lg:text-xs">
                  {item.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ConvergenceNote() {
  return (
    <div className="relative w-full max-w-[380px] overflow-hidden rounded-sm border border-zinc-300 bg-white lg:ml-auto">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage: "radial-gradient(circle,#000 1px,transparent 1px)",
          backgroundSize: "4px 4px",
        }}
      />

      <div className="relative z-10 p-6 sm:p-8 md:p-10">
        <div className="text-4xl leading-none text-zinc-900 sm:text-5xl">
          “
        </div>

        <p className="mt-3 text-sm leading-6 text-zinc-700 sm:text-base sm:leading-7 md:text-lg">
          No merge dialogs, no &ldquo;keep mine or theirs.&rdquo; Concurrent
          edits from every collaborator converge automatically, even after
          long offline stretches.
        </p>

        <div className="mt-8 flex items-center gap-3 sm:mt-10">
          <div>
            <div className="text-sm font-medium text-zinc-900 sm:text-base">
              The merge engine
            </div>

            <div className="text-xs text-zinc-500 sm:text-sm">
              Sequence CRDT (RGA)
            </div>
          </div>
        </div>
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-sm"
        style={{
          boxShadow:
            "inset 0 0 0 1px rgba(255,255,255,0.7), 0 0 40px rgba(180,255,220,0.15)",
        }}
      />
    </div>
  );
}