"use client";

export default function GroundworkQuote() {
  return (
    <section className="py-24">
      <div className="w-full px-4 sm:px-6 lg:px-10">
        <div className="relative overflow-hidden border border-white/15 bg-black">
          <div
            className="absolute inset-0 opacity-[0.12]"
            style={{
              backgroundImage: `
                linear-gradient(to right, white 1px, transparent 1px),
                linear-gradient(to bottom, white 1px, transparent 1px)
              `,
              backgroundSize: "56px 56px",
            }}
          />

          {/* vignette */}
          <div className="absolute inset-0 bg-black/[0.04]" />

          <div className="relative z-10 flex min-h-[620px]">
            {/* LEFT */}
            <div className="flex w-full flex-col justify-between p-16 lg:w-[58%]">
              <div>
                {/* Quote */}
                <svg
                  className="mb-10 h-20 w-20 text-white"
                  viewBox="0 0 48 48"
                  fill="none"
                >
                  <path
                    d="M10 12C5 16 4 22 4 28h12v16H0V28C0 18 4 10 10 4L10 12ZM34 12C29 16 28 22 28 28h12v16H24V28C24 18 28 10 34 4V12Z"
                    fill="white"
                  />
                </svg>

                <p className="max-w-2xl text-[clamp(2.2rem,3.5vw,4.2rem)] font-medium leading-[1.08] tracking-[-0.05em] text-white">
                  Most collaborative editors either lock the document while
                  someone else edits, or quietly drop your changes when you
                  reconnect. YSync does neither it&rsquo;s built on a real
                  CRDT, verified against thousands of simulated offline and
                  concurrent edits.
                </p>
              </div>

              {/* Author */}
              <div className="mt-20 flex items-center gap-5">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white text-lg font-semibold text-black shadow-lg">
                  KB
                </div>

                <div>
                  <h4 className="text-[15px] font-semibold text-white md:text-[18px]">
                    Kartikey Bhatnagar
                  </h4>

                  <p className="mt-1 text-[13px] text-white/80 md:text-sm">
                    Creator of YSync
                  </p>
                </div>
              </div>
            </div>

            {/* RIGHT */}
            <div className="relative hidden flex-1 overflow-hidden lg:block">
              <svg
                className="absolute inset-0 h-full w-full"
                viewBox="0 0 700 700"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <g
                  stroke="white"
                  strokeOpacity="0.22"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                >
                  {/* outer */}
                  <path d="M520 90L630 200L520 310L410 200L520 90Z" />
                  <path d="M520 310L630 420L520 530L410 420L520 310Z" />
                  <path d="M300 200L410 90L520 200L410 310L300 200Z" />
                  <path d="M300 420L410 310L520 420L410 530L300 420Z" />

                  {/* center */}
                  <path d="M410 200L520 310L410 420L300 310L410 200Z" />

                  {/* left */}
                  <path d="M190 310L300 200L410 310L300 420L190 310Z" />

                  {/* top */}
                  <path d="M410 -20L520 90L410 200L300 90L410 -20Z" />

                  {/* bottom */}
                  <path d="M410 530L520 640L410 750L300 640L410 530Z" />

                  {/* right */}
                  <path d="M520 200L630 90L740 200L630 310L520 200Z" />
                  <path d="M520 420L630 310L740 420L630 530L520 420Z" />

                  {/* connecting */}
                  <path d="M300 90L300 640" />
                  <path d="M520 90L520 640" />
                  <path d="M190 310H740" />
                  <path d="M300 200L630 530" />
                  <path d="M300 420L630 90" />
                </g>

                <defs>
                  <radialGradient id="glow">
                    <stop offset="0%" stopColor="white" stopOpacity=".9" />
                    <stop offset="100%" stopColor="white" stopOpacity="0" />
                  </radialGradient>
                </defs>
              </svg>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
