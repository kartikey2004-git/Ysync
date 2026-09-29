"use client";

import { Step, steps } from "@/lib/landing-data";

export default function ProcessSection() {
  return (
    <section className="bg-white">
      <div className="w-full px-4 py-24 sm:px-6 lg:px-10">
        {/* header */}
        <div className="mx-auto mb-14 max-w-6xl">
          <div className="mb-5 inline-flex items-center border border-neutral-200 bg-neutral-50 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.25em] text-neutral-500">
            How it works
          </div>
          <h2 className="max-w-xl text-3xl font-medium tracking-tight text-black md:text-4xl">
            From your keystroke to every replica, in five steps.
          </h2>
        </div>

        {/* 3 + 2 bento */}
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-px bg-neutral-200 md:grid-cols-6">
          {steps.slice(0, 3).map((step) => (
            <div key={step.id} className="bg-white md:col-span-2">
              <StepCard step={step} />
            </div>
          ))}
          {steps.slice(3, 5).map((step) => (
            <div key={step.id} className="bg-white md:col-span-3">
              <StepCard step={step} wide />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function StepCard({ step, wide = false }: { step: Step; wide?: boolean }) {
  const Icon = step.icon;
  const stepIndex = steps.findIndex((s) => s.id === step.id);

  return (
    <div className={`flex h-full flex-col p-8 ${wide ? "md:flex-row md:gap-12" : ""}`}>
      {/* left col in wide mode */}
      <div className={wide ? "md:w-56 md:shrink-0" : ""}>
        {/* step number + icon */}
        <div className="mb-8 flex items-center justify-between">
          <div className="flex h-10 w-10 items-center justify-center border border-neutral-200 bg-neutral-50">
            <Icon className="h-4 w-4 text-neutral-700" />
          </div>
          <span className="font-mono text-[11px] tracking-[0.18em] text-neutral-400">
            {String(step.id).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}
          </span>
        </div>

        <h3 className="text-xl font-medium tracking-tight text-black">
          {step.title}
        </h3>

        {/* tags */}
        <div className="mt-4 flex flex-wrap gap-1.5">
          {step.tags.map((tag) => (
            <span
              key={tag}
              className="border border-neutral-200 px-2.5 py-0.5 text-[11px] font-medium text-neutral-500"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      {/* description */}
      <div className={`mt-6 ${wide ? "md:mt-0 md:flex-1" : ""}`}>
        <p className="text-sm leading-relaxed text-neutral-500">
          {step.panelDescription}
        </p>
        <p className="mt-2 text-[11px] text-neutral-400">
          Stage {step.id} of {steps.length}
        </p>
      </div>
    </div>
  );
}
