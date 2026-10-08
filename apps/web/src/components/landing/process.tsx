"use client";

import { Sparkles } from "lucide-react";
import { Step, steps } from "@/lib/landing-data";

const SPANS = [
  "lg:col-span-4",
  "lg:col-span-2",
  "lg:col-span-2",
  "lg:col-span-2",
  "lg:col-span-2",
];

export default function ProcessSection() {
  return (
    <section className="overflow-hidden bg-white text-black">
      <div className="w-full py-16 sm:py-20 lg:py-24">
        <div className="mx-auto mb-10 max-w-6xl px-4 sm:mb-12 sm:px-6 lg:px-10">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-black/40">
            Process
          </p>

          <h2 className="mt-3 text-3xl font-medium tracking-tight text-black sm:text-4xl">
            How it works
          </h2>
        </div>

        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-10">
        <div className="grid w-full grid-cols-1 border-l border-t border-black/10 sm:grid-cols-2 lg:grid-cols-6">
          {steps.map((step, index) => (
            <BentoCard
              key={step.id}
              step={step}
              className={SPANS[index] ?? ""}
              featured={false}
            />
          ))}
        </div>
        </div>
      </div>
    </section>
  );
}

function BentoCard({
  step,
  className,
  featured,
}: {
  step: Step;
  className: string;
  featured: boolean;
}) {
  const Icon = step.icon;
  const total = steps.length;

  return (
    <div
      className={`relative flex min-h-[260px] flex-col justify-between overflow-hidden border-b border-r p-6 sm:p-7 lg:p-8 ${
        featured
          ? "border-white/15 bg-black text-white"
          : "border-black/10 bg-white text-black"
      } ${className}`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: featured
            ? "radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1px)"
            : "radial-gradient(circle, rgba(0,0,0,0.045) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
      />

      <div className="relative flex items-center justify-between">
        <div
          className={`flex h-11 w-11 items-center justify-center border ${
            featured ? "border-white/15 bg-white/[0.06]" : "border-black/10 bg-black/[0.03]"
          }`}
        >
          <Icon className="h-5 w-5" strokeWidth={1.5} />
        </div>

        <span
          className={`font-mono text-xs ${featured ? "text-white/40" : "text-black/40"}`}
        >
          {String(step.id).padStart(2, "0")} / {String(total).padStart(2, "0")}
        </span>
      </div>

      <div className="relative mt-10">
        <div
          className={`mb-3 inline-flex items-center gap-2 border px-3 py-1 text-xs ${
            featured
              ? "border-white/15 bg-white/[0.06] text-white/70"
              : "border-black/10 bg-black/[0.03] text-black/60"
          }`}
        >
          <Sparkles className="h-3 w-3" />
          {step.panelTitle}
        </div>

        <h3 className="text-xl font-medium tracking-tight sm:text-2xl">
          {step.title}
        </h3>

        <p
          className={`mt-3 max-w-[44ch] text-sm leading-relaxed sm:text-base ${
            featured ? "text-white/60" : "text-black/60"
          }`}
        >
          {step.panelDescription}
        </p>
      </div>

      <div className="relative mt-8">
        <div className="flex flex-wrap gap-2">
          {step.tags.map((tag) => (
            <span
              key={tag}
              className={`border px-3 py-1 text-xs ${
                featured
                  ? "border-white/15 bg-white/[0.06] text-white/70"
                  : "border-black/10 bg-black/[0.03] text-black/70"
              }`}
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
