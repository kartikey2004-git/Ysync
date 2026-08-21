"use client";

import { Sparkles } from "lucide-react";
import { Step, steps } from "@/lib/landing-data";

export default function ProcessSection() {
  return (
    <section className="bg-black text-white">
      <div className="w-full px-4 py-24 sm:px-6 lg:px-10">
        <div className="mx-auto flex max-w-6xl flex-wrap justify-center gap-6">
          {steps.map((step) => (
            <div
              key={step.id}
              className="w-full sm:w-[calc(50%-12px)] lg:w-[calc(33.333%-16px)]"
            >
              <SignalCard step={step} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SignalCard({ step }: { step: Step }) {
  const Icon = step.icon;
  const stepIndex = steps.findIndex((s) => s.id === step.id);

  return (
    <div className="relative flex h-full flex-col overflow-hidden border border-white/10 bg-white/[0.03] p-8">
      <div className="relative flex items-center justify-between">
        <div className="flex h-11 w-11 items-center justify-center border border-white/10 bg-white/5">
          <Icon className="h-5 w-5 text-white" />
        </div>
        <span className="font-mono text-xs tracking-[0.2em] text-white/40">
          {String(step.id).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}
        </span>
      </div>

      <div className="relative mt-8">
        <div className="mb-3 inline-flex items-center gap-2 border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/60">
          <Sparkles className="h-3 w-3" />
          {step.panelTitle}
        </div>
        <h3 className="text-2xl font-medium tracking-tight">{step.title}</h3>
        <p className="mt-4 leading-relaxed text-white/60">
          {step.panelDescription}
        </p>
      </div>

      <div className="relative mt-8 flex flex-wrap gap-2">
        {step.tags.map((tag) => (
          <span
            key={tag}
            className="border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70"
          >
            {tag}
          </span>
        ))}
      </div>

      <div className="relative mt-auto pt-10">
        <div className="border-t border-white/10 pt-6">
          <div className="flex items-center">
            {steps.map((s, i) => {
              const isDone = i < stepIndex;
              const isCurrent = i === stepIndex;
              return (
                <div key={s.id} className="flex flex-1 items-center last:flex-none">
                  <div
                    className={`h-2 w-2 shrink-0 transition-colors ${
                      isDone || isCurrent ? "bg-white" : "bg-white/15"
                    }`}
                  />
                  {i < steps.length - 1 && (
                    <div
                      className={`mx-1.5 h-px flex-1 transition-colors ${
                        isDone ? "bg-white/50" : "bg-white/10"
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-white/40">
            Stage {step.id} of {steps.length}
          </p>
        </div>
      </div>
    </div>
  );
}
