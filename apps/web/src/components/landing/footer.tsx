"use client"

export function GroundworkFooter() {
  return (
    <footer className="relative overflow-hidden bg-[#0a0a0a] text-white -mb-20">

      <div className="relative grid grid-cols-1 md:grid-cols-2">
    
        <div className="px-8 py-14 md:px-12">
          <div className="flex items-center gap-2">
            
            <span className="text-lg font-semibold">YSync</span>
          </div>
          
          <h3 className="mt-8 max-w-md text-2xl font-semibold leading-snug text-white">
            Real-time collaborative editing, built on a real CRDT.
          </h3>

          <p className="mt-3 text-sm text-white/50">
            <span className="font-medium text-white/70">Contact:</span>{" "}
            kartikeybhatnagar247@gmail.com
          </p>
        </div>
      </div>

      <div className="relative flex flex-col items-start justify-between gap-3 px-8 py-6 md:flex-row md:items-center md:px-12">
        <span />
        <div className="flex flex-wrap items-center gap-6 text-xs uppercase tracking-[0.08em] text-white/40">
          <span className="text-white/70">© 2026 CollabX. All rights reserved.</span>
          <a href="#" className="hover:text-white">
            Privacy Policy
          </a>
          <a href="#" className="hover:text-white">
            Terms of Service
          </a>
        </div>
      </div>

      <div className="relative h-[280px] overflow-hidden md:h-[360px]">
        <svg
          className="absolute -bottom-6 left-[-10px] h-[320px] w-[320px] text-white/10 md:left-4"
          viewBox="0 0 320 320"
          fill="none"
        >
          <g stroke="currentColor" strokeWidth="2">
            <rect
              x="60"
              y="60"
              width="120"
              height="120"
              transform="rotate(45 120 120)"
            />
            <rect
              x="140"
              y="60"
              width="120"
              height="120"
              transform="rotate(-45 200 120)"
            />
          </g>
        </svg>

        <div
          className="absolute -bottom-8 left-[260px] whitespace-nowrap text-[220px] font-bold leading-none tracking-tight md:left-[240px] md:text-[220px]"
          style={{
            WebkitTextStroke: "1px rgba(255,255,255,0.12)",
            color: "transparent",
          }}
        >
          Ysync
        </div>
      </div>

      <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.15] mix-blend-overlay">
        <filter id="footer-grain">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="2"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#footer-grain)" />
      </svg>
    </footer>
  );
}
