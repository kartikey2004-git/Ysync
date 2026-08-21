"use client";

import { Feature, leftFeatures, rightFeatures } from "@/lib/landing-data";
import { ArrowRight } from "lucide-react";

export default function GroundworkEngineSection({
  onCreateNew,
}: {
  onCreateNew?: () => void;
}) {
  return (
    <section className="bg-black py-16">
      <div className="w-full px-4 sm:px-6 lg:px-10">
        <div className="flex flex-col justify-between gap-8 pb-12 md:flex-row md:items-start">
          <div>
            <h2 className="text-2xl font-semibold text-white md:text-3xl">
              Powered by the YSync
            </h2>
            <h2 className="bg-gradient-to-r from-sky-400 via-violet-400 to-orange-400 bg-clip-text text-2xl font-semibold text-transparent md:text-3xl p-0.5">
              CRDT Engine
            </h2>
          </div>

          <div className="max-w-sm md:text-right">
            <p className="text-sm leading-relaxed text-zinc-500">
              Most collaborative tools either lock the document while someone
              else edits, or silently drop your changes when you reconnect.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-zinc-500">
              With YSync, every edit is preserved and merged automatically —
              no matter the order it arrives in.
            </p>

            <button
              onClick={onCreateNew}
              className="mt-4 inline-flex items-center gap-2 border border-white bg-white px-4 py-2 text-xs font-medium text-black transition hover:bg-zinc-200"
            >
              Get Started
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 border border-zinc-800 md:grid-cols-[1fr_240px_1fr]">
          <div className="grid grid-rows-5 divide-y divide-zinc-800 border-b border-zinc-800 md:border-b-0 md:border-r">
            <FeatureCell feature={leftFeatures[0]} />
            <EmptyCell />
            <FeatureCell feature={leftFeatures[1]} />
            <EmptyCell />
            <FeatureCell feature={leftFeatures[2]} />
          </div>

          <div className="relative hidden items-center justify-center md:flex">
            <StackIllustration />
          </div>

          <div className="grid grid-rows-5 divide-y divide-zinc-800 border-t border-zinc-800 md:border-l md:border-t-0">
            <EmptyCell />
            <FeatureCell feature={rightFeatures[0]} />
            <EmptyCell />
            <FeatureCell feature={rightFeatures[1]} />
            <EmptyCell />
          </div>
        </div>
      </div>
    </section>
  );
}

function FeatureCell({ feature }: { feature: Feature }) {
  const Icon = feature.icon;

  return (
    <div className={`relative p-5 ${feature.accent ? "" : ""}`}>
      <Icon className="mb-3 h-4 w-4 text-zinc-400" strokeWidth={1.5} />
      <h3 className="text-md tracking-tight text-white">{feature.title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-500">
        {feature.description}
      </p>
    </div>
  );
}

function EmptyCell() {
  return <div className="min-h-[110px]" />;
}

function StackIllustration() {
  return (
    <div className="relative flex justify-center bg-black py-10">
      <svg
        width="260"
        height="660"
        viewBox="0 0 260 660"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient
            id="deviceFace"
            x1="20"
            y1="10"
            x2="240"
            y2="95"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#050505" />
            <stop offset="55%" stopColor="#0d0d0f" />
            <stop offset="100%" stopColor="#050505" />
          </linearGradient>

          <linearGradient
            id="iridescence"
            x1="20"
            y1="0"
            x2="240"
            y2="0"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#7dd3fc" />
            <stop offset="35%" stopColor="#f5f5f5" />
            <stop offset="65%" stopColor="#fdba74" />
            <stop offset="100%" stopColor="#f9a8d4" />
          </linearGradient>

          <linearGradient id="deviceSide" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#151517" />
            <stop offset="100%" stopColor="#080808" />
          </linearGradient>

          <path
            id="plateTop"
            d="M130 0
               C136 0 142 1.5 147 4
               L226 40
               C233 43 233 51 226 54
               L147 90
               C142 92.5 136 94 130 94
               C124 94 118 92.5 113 90
               L34 54
               C27 51 27 43 34 40
               L113 4
               C118 1.5 124 0 130 0 Z"
          />
        </defs>

        <filter id="stackGrain">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="2"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="260" height="660" fill="black" />
        <rect
          width="260"
          height="660"
          filter="url(#stackGrain)"
          opacity="0.05"
        />

        <g stroke="#4b4b4f" strokeWidth="1" strokeDasharray="2 5">
          <path d="M34 90 V610" />
          <path d="M130 130 V630" />
          <path d="M226 90 V610" />
        </g>

        <g>
          <path
            d="M34 40 L34 90 L130 130 L226 90 L226 40 L130 76 Z"
            fill="url(#deviceSide)"
            stroke="#2c2c30"
            strokeWidth="1"
          />

          {/* iridescent edge line along the bottom of the side wall */}
          <path
            d="M34 88 L130 128 L226 88"
            stroke="url(#iridescence)"
            strokeWidth="2.5"
            strokeLinecap="round"
            opacity="0.9"
          />

          {/* vent slats on the left face */}
          <g stroke="#3a3a3e" strokeWidth="1.6" strokeLinecap="round">
            <path d="M40 52 L40 74" />
            <path d="M45 54 L45 76" />
            <path d="M50 56 L50 78" />
            <path d="M55 58 L55 80" />
            <path d="M60 60 L60 82" />
          </g>

          {/* top face */}
          <path
            d="M130 4
               C136 4 142 5.5 147 8
               L222 42
               C228 45 228 51 222 54
               L147 88
               C142 90.5 136 92 130 92
               C124 92 118 90.5 113 88
               L38 54
               C32 51 32 45 38 42
               L113 8
               C118 5.5 124 4 130 4 Z"
            fill="url(#deviceFace)"
            stroke="#e5e5e5"
            strokeOpacity="0.35"
            strokeWidth="1.2"
          />

          <g
            stroke="#f4f4f5"
            strokeWidth="4.5"
            strokeLinecap="round"
            transform="translate(130 48)"
          >
            <path d="M0 -16 L0 16" />
            <path d="M-14 -8 L14 8" />
            <path d="M14 -8 L-14 8" />
          </g>
        </g>

        <StackLayer cy={230} opacity={0.85} />
        <StackLayer cy={345} opacity={0.55} />
        <StackLayer cy={460} opacity={0.35} />
        <StackLayer cy={575} opacity={0.18} />
      </svg>
    </div>
  );
}

function StackLayer({ cy, opacity }: { cy: number; opacity: number }) {
  return (
    <g opacity={opacity}>
      <path
        d={`
          M34 ${cy + 40}
          L34 ${cy + 88}
          L130 ${cy + 128}
          L226 ${cy + 88}
          L226 ${cy + 40}
          L130 ${cy + 76}
          Z
        `}
        fill="url(#deviceSide)"
        stroke="#2c2c30"
        strokeWidth="1"
      />

      <use
        href="#plateTop"
        transform={`translate(0 ${cy})`}
        fill="url(#deviceFace)"
        stroke="#f3f4f6"
        strokeOpacity="0.25"
        strokeWidth="1"
      />

      <path
        d={`
          M34 ${cy + 86}
          L130 ${cy + 126}
          L226 ${cy + 86}
        `}
        stroke="url(#iridescence)"
        strokeWidth="2"
        strokeLinecap="round"
      />

      <circle cx="34" cy={cy + 47} r="2.2" fill="#7d7d82" />
      <circle cx="226" cy={cy + 47} r="2.2" fill="#7d7d82" />
      <circle cx="130" cy={cy} r="2.2" fill="#7d7d82" />
      <circle cx="130" cy={cy + 94} r="2.2" fill="#7d7d82" />
    </g>
  );
}
