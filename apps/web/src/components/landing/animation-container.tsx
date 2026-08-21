"use client";

import { Path, PATHS } from "@/lib/landing-data";
import { motion } from "framer-motion";

export const AnimationContainer = () => {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 mx-auto max-w-[734px]">
      <svg
        viewBox="0 0 734 405"
        className="block h-[405px] w-full overflow-visible"
        fill="none"
      >
        {PATHS.map((path: Path) => (
          <AnimatedLine key={`${path.d}-${path.transform}`} {...path} />
        ))}
      </svg>
    </div>
  );
};

const SEGMENT = 0.12;
const GAP = 0.88;

export const AnimatedLine = ({
  d,
  transform,
}: {
  d: string;
  transform: string;
}) => {
  return (
    <g transform={transform}>
      <path
        d={d}
        fill="none"
        stroke="rgba(0,0,0,0.08)"
        strokeWidth={1.5}
        strokeLinecap="round"
      />

      <motion.path
        d={d}
        fill="none"
        stroke="black"
        strokeWidth={3}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray={`${SEGMENT} ${GAP}`}
        initial={{ strokeDashoffset: 0 }}
        animate={{ strokeDashoffset: -1 }}
        transition={{
          duration: 2.5,
          ease: "linear",
          repeat: Infinity,
        }}
      />

      <circle r="10" fill="black" opacity="0.08">
        <animateMotion dur="2.5s" repeatCount="indefinite" path={d} />
      </circle>

      <circle r="3" fill="black">
        <animateMotion dur="2.5s" repeatCount="indefinite" path={d} />
      </circle>
    </g>
  );
};
