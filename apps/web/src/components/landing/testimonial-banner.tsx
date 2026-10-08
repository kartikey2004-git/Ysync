"use client";

export default function GroundworkQuote() {
  return (
    <section className="py-12 sm:py-16 lg:py-20">
      <div className="w-full px-3 sm:px-6 lg:px-10">
        <div className="relative overflow-hidden border border-white/15 bg-black">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.12]"
            style={{
              backgroundImage: `
                linear-gradient(to right, white 1px, transparent 1px),
                linear-gradient(to bottom, white 1px, transparent 1px)
              `,
              backgroundSize:
                "clamp(32px, 5vw, 56px) clamp(32px, 5vw, 56px)",
            }}
          />

          <div className="pointer-events-none absolute inset-0 bg-black/[0.04]" />

          <div className="relative z-10 flex min-h-0 flex-col lg:min-h-[500px] lg:flex-row">
            <div className="flex w-full flex-col justify-between p-6 sm:p-10 md:p-12 lg:w-[58%] lg:p-12">
              <div>
                <svg
                  className="mb-6 h-12 w-12 text-white sm:mb-8 sm:h-14 sm:w-14 lg:mb-8 lg:h-16 lg:w-16"
                  viewBox="0 0 48 48"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M10 12C5 16 4 22 4 28h12v16H0V28C0 18 4 10 10 4L10 12ZM34 12C29 16 28 22 28 28h12v16H24V28C24 18 28 10 34 4V12Z"
                    fill="white"
                  />
                </svg>

                <p className="max-w-3xl text-[clamp(1.8rem,3.2vw,3.5rem)] font-medium leading-[1.08] tracking-[-0.045em] text-white">
                  Most collaborative editors either lock the document while
                  someone else edits, or quietly drop your changes when you
                  reconnect. YSync does neither, it's built on a real CRDT
                  verified against thousands of simulated offline and
                  concurrent edits.
                </p>
              </div>

              <div className="mt-10 flex items-center sm:mt-14 lg:mt-12">
                <div>
                  <h4 className="text-[15px] font-semibold text-white sm:text-[16px]">
                    Kartikey Bhatnagar
                  </h4>

                  <p className="mt-1 text-[12px] text-white/70 sm:text-[13px]">
                    Creator of YSync
                  </p>
                </div>
              </div>
            </div>

            <div className="relative hidden flex-1 overflow-hidden lg:block">
              <svg
                className="absolute inset-0 h-full w-full"
                viewBox="0 0 700 700"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <g
                  stroke="white"
                  strokeOpacity="0.22"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                >
                  <path d="M520 90L630 200L520 310L410 200L520 90Z" />
                  <path d="M520 310L630 420L520 530L410 420L520 310Z" />
                  <path d="M300 200L410 90L520 200L410 310L300 200Z" />
                  <path d="M300 420L410 310L520 420L410 530L300 420Z" />

                  <path d="M410 200L520 310L410 420L300 310L410 200Z" />

                  <path d="M190 310L300 200L410 310L300 420L190 310Z" />

                  <path d="M410 -20L520 90L410 200L300 90L410 -20Z" />

                  <path d="M410 530L520 640L410 750L300 640L410 530Z" />

                  <path d="M520 200L630 90L740 200L630 310L520 200Z" />
                  <path d="M520 420L630 310L740 420L630 530L520 420Z" />

                  <path d="M300 90L300 640" />
                  <path d="M520 90L520 640" />
                  <path d="M190 310H740" />
                  <path d="M300 200L630 530" />
                  <path d="M300 420L630 90" />
                </g>
              </svg>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}