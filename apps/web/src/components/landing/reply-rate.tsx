"use client";

import { chartData, ChartStep } from "@/lib/landing-data";
import { motion } from "framer-motion";

export default function ReplyRateSection() {
  return (
    <section className="relative overflow-hidden bg-[#fafafa] py-16">
      <div
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "radial-gradient(circle,#d4d4d4 1px,transparent 1px)",
          backgroundSize: "16px 16px",
        }}
      />

      <div className="relative w-full border border-zinc-200 bg-[#f8f8f8] p-6 sm:p-10 md:p-20">
        <div className="max-w-5xl">
          <div className="inline-flex items-center bg-neutral-100 px-3 py-2 text-xs uppercase tracking-[0.2em] text-neutral-700">
            • ONE DOCUMENT. ZERO CONFLICTS.
          </div>

          <h2 className="mt-6 text-3xl font-medium tracking-tight text-black md:text-5xl">
            Every Replica Converges, By Design.
          </h2>

          <p className="mt-6 max-w-5xl text-zinc-600">
            YSync&rsquo;s sync engine is a sequence CRDT, an RGA variant that
            keeps every replica&rsquo;s history addressable by origin, not
            position, verified against thousands of simulated out-of-order,
            concurrent, offline edits.
          </p>

          <p className="mt-5 text-zinc-700">
            The difference: your edits stay connected from the first keystroke
            to the final, converged document.
          </p>
        </div>

        <div className="mt-14 grid gap-8 lg:grid-cols-[1.5fr_0.9fr] -ml-2">
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
    <div className="relative h-[400px]">
      <div className="mb-8 text-center font-mono text-xs uppercase tracking-[0.3em] text-zinc-600">
        Path to a Converged Document
      </div>

      <div className="relative h-[320px] border-l border-b border-zinc-300">
        {[0, 20, 40, 60, 80, 100].map((tick) => (
          <div
            key={tick}
            className="absolute left-0 right-0 border-t border-dashed border-zinc-200"
            style={{
              bottom: `${(tick / maxValue) * 100}%`,
            }}
          >
            <span className="absolute -left-10 -top-3 text-xs text-zinc-500">
              {tick}%
            </span>
          </div>
        ))}

        <div className="absolute inset-0 flex items-end justify-around px-6 pb-0">
          {chartData.map((item: ChartStep, index) => (
            <div
              key={item.label}
              className="flex h-full flex-col items-center justify-end"
            >
              <motion.div
                initial={{ height: 0 }}
                whileInView={{
                  height: `${(item.value / maxValue) * 100}%`,
                }}
                viewport={{ once: true }}
                transition={{
                  duration: 1,
                  delay: index * 0.15,
                  ease: "easeOut",
                }}
                whileHover={{
                  y: -4,
                }}
                className={`relative w-20 border ${
                  item.featured ? "border-emerald-200" : "border-zinc-300"
                }`}
              >
                {!item.featured && (
                  <>
                    <div
                      className="absolute inset-0 opacity-60"
                      style={{
                        background:
                          "repeating-linear-gradient(135deg,#ddd,#ddd 2px,transparent 2px,transparent 6px)",
                      }}
                    />
                  </>
                )}

                {item.featured && (
                  <>
                    <motion.div
                      animate={{
                        opacity: [0.4, 0.8, 0.4],
                      }}
                      transition={{
                        duration: 5,
                        repeat: Infinity,
                      }}
                      className="absolute inset-0"
                      style={{
                        background:
                          "linear-gradient(135deg,#ffd9d9,#d8fff4,#ddd9ff)",
                      }}
                    />

                    <div className="absolute inset-0 backdrop-blur-sm" />
                  </>
                )}

                <div className="absolute left-3 top-3 z-10 text-xs text-zinc-700">
                  {item.value}%
                </div>
              </motion.div>

              <div className="mt-4 text-center font-mono text-xs uppercase tracking-[0.15em] text-zinc-600">
                {item.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConvergenceNote() {
  return (
    <motion.div
      whileHover={{
        y: -6,
      }}
      className="group relative max-w-[380px] overflow-hidden rounded-sm border border-zinc-300 bg-white"
    >
      <motion.div
        animate={{
          rotate: [0, 360],
        }}
        transition={{
          duration: 20,
          repeat: Infinity,
          ease: "linear",
        }}
        className="absolute -inset-40 opacity-70"
        style={{
          background:
            "conic-gradient(from 0deg,#ffd7d7,#d7fff4,#ddd7ff,#ffd7d7)",
          filter: "blur(80px)",
        }}
      />

      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage: "radial-gradient(circle,#000 1px,transparent 1px)",
          backgroundSize: "4px 4px",
        }}
      />

      <div className="relative z-10 p-8 md:p-10">
        <div className="text-5xl leading-none text-zinc-900">“</div>

        <p className="mt-3 text-base leading-relaxed text-zinc-700 md:text-lg">
          No merge dialogs, no &ldquo;keep mine or theirs.&rdquo; Concurrent
          edits from every collaborator converge automatically, even after
          long offline stretches.
        </p>

        <div className="mt-10 flex items-center gap-3">
          <div className="h-12 w-12 rounded-full bg-gradient-to-br from-neutral-300 to-neutral-500" />

          <div>
            <div className="font-medium text-zinc-900">The merge engine</div>

            <div className="text-sm text-zinc-500">Sequence CRDT (RGA)</div>
          </div>
        </div>
      </div>

      <div
        className="pointer-events-none absolute inset-0 rounded-sm"
        style={{
          boxShadow:
            "inset 0 0 0 1px rgba(255,255,255,0.7), 0 0 40px rgba(180,255,220,0.15)",
        }}
      />
    </motion.div>
  );
}
