"use client";

export default function CaseStudiesSection({
  onCreateNew,
}: {
  onCreateNew?: () => void;
}) {
  return (
    <section className="relative w-full overflow-hidden bg-[#fafafa] py-16 sm:py-20 lg:py-24">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage:
            "radial-gradient(#d4d4d4 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
      />

      <div className="relative z-10 mx-auto w-full max-w-[1400px] px-4 sm:px-6 lg:px-8 xl:px-10">
        <div className="p-3 sm:p-4 md:p-6 lg:p-8">
          <div className="mb-8 px-2 py-6 text-center sm:mb-10 sm:py-8 lg:mb-12">
            <div className="mb-4 inline-flex border border-neutral-200 bg-neutral-100 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-neutral-600 sm:text-[10px] sm:tracking-[0.25em]">
              For writers, teams &amp; remote collaborators
            </div>

            <h2 className="mx-auto max-w-[850px] text-[clamp(2rem,5vw,3.75rem)] font-medium leading-[1.02] tracking-[-0.045em] text-black">
              Everything Between a Blank Page
              <br className="hidden sm:block" />
              <span className="sm:ml-2">
                and a Synced Document.
              </span>
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-px bg-zinc-300 sm:grid-cols-2 lg:grid-cols-12">
            <CaseCard
              company="Presence"
              title="See exactly who's editing, with live cursors and a distinct color for every collaborator."
              className="min-h-[270px] sm:min-h-[300px] lg:col-span-4"
              illustration={<PresenceIllustration />}
            />

            <CaseCard
              company="Merge"
              title="Concurrent edits converge, automatically."
              className="min-h-[270px] sm:min-h-[300px] lg:col-span-4"
              illustration={<MergeIllustration />}
            />

            <GalileoCard className="min-h-[330px] sm:min-h-[430px] lg:col-span-4 lg:row-span-2" />

            <CaseCard
              company="Share"
              title="One short link is all it takes for anyone to join and start editing."
              className="min-h-[270px] sm:min-h-[300px] lg:col-span-4"
              illustration={<ShareIllustration />}
            />

            <CaseCard
              company="History"
              title="Every edit is addressable by origin, not position. Nothing is ever overwritten."
              className="min-h-[270px] sm:col-span-2 sm:min-h-[300px] lg:col-span-4"
              illustration={<HistoryIllustration />}
            />
          </div>

          <CTABanner onCreateNew={onCreateNew} />
        </div>
      </div>
    </section>
  );
}

function CaseCard({
  title,
  company,
  className = "",
  illustration,
}: {
  title: string;
  company: string;
  className?: string;
  illustration?: React.ReactNode;
}) {
  return (
    <div
      className={`relative flex flex-col overflow-hidden bg-white ${className}`}
    >
      <div className="relative z-10 flex h-full flex-col p-4 sm:p-5">
        <div className="text-sm font-semibold text-black sm:text-base">
          {company}
        </div>

        <div className="flex min-h-[130px] flex-1 items-center justify-center py-5 sm:min-h-[150px] sm:py-6">
          {illustration}
        </div>

        <h3 className="max-w-[320px] text-sm leading-[1.45] text-black sm:text-[15px]">
          {title}
        </h3>
      </div>
    </div>
  );
}

function PresenceIllustration() {
  return (
    <svg
      viewBox="0 0 320 150"
      className="h-auto w-full max-w-[300px]"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="75"
        y="25"
        width="170"
        height="100"
        rx="2"
        stroke="black"
        strokeWidth="1"
      />

      <path d="M95 48H190" stroke="black" strokeOpacity="0.25" />
      <path d="M95 62H220" stroke="black" strokeOpacity="0.15" />
      <path d="M95 76H180" stroke="black" strokeOpacity="0.15" />
      <path d="M95 90H210" stroke="black" strokeOpacity="0.15" />

      <path d="M128 43V82" stroke="black" strokeWidth="1.5" />

      <path
        d="M128 43L141 51L135 54L141 63L137 65L131 56L126 61L128 43Z"
        fill="black"
      />

      <path d="M183 65V103" stroke="black" strokeWidth="1.5" />

      <path
        d="M183 65L196 73L190 76L196 85L192 87L186 78L181 83L183 65Z"
        fill="black"
      />

      <circle cx="52" cy="45" r="12" stroke="black" />

      <circle cx="52" cy="42" r="3" fill="black" />

      <path
        d="M45 54C47 48 57 48 59 54"
        stroke="black"
        strokeWidth="1.2"
      />

      <circle cx="268" cy="105" r="12" stroke="black" />

      <circle cx="268" cy="102" r="3" fill="black" />

      <path
        d="M261 114C263 108 273 108 275 114"
        stroke="black"
        strokeWidth="1.2"
      />

      <path
        d="M64 48L75 52"
        stroke="black"
        strokeOpacity="0.25"
        strokeDasharray="3 3"
      />

      <path
        d="M245 101L256 105"
        stroke="black"
        strokeOpacity="0.25"
        strokeDasharray="3 3"
      />
    </svg>
  );
}

function MergeIllustration() {
  return (
    <svg
      viewBox="0 0 320 150"
      className="h-auto w-full max-w-[300px]"
      fill="none"
      aria-hidden="true"
    >

      <rect
        x="10"
        y="18"
        width="82"
        height="48"
        stroke="black"
        strokeWidth="1"
      />

      <text
        x="20"
        y="31"
        fontSize="8"
        fill="black"
        opacity="0.5"
      >
        REPLICA A
      </text>

      <path
        d="M20 43H68"
        stroke="black"
        strokeOpacity="0.2"
      />

      <path
        d="M20 52H58"
        stroke="black"
        strokeOpacity="0.12"
      />

      <circle
        cx="76"
        cy="52"
        r="4"
        fill="black"
      />

      <text
        x="68"
        y="64"
        fontSize="6"
        fill="black"
        opacity="0.45"
      >
        op₁
      </text>

      <rect
        x="10"
        y="84"
        width="82"
        height="48"
        stroke="black"
        strokeWidth="1"
      />

      <text
        x="20"
        y="97"
        fontSize="8"
        fill="black"
        opacity="0.5"
      >
        REPLICA B
      </text>

      <path
        d="M20 109H70"
        stroke="black"
        strokeOpacity="0.2"
      />

      <path
        d="M20 118H82"
        stroke="black"
        strokeOpacity="0.12"
      />

      <circle
        cx="76"
        cy="109"
        r="4"
        fill="black"
      />

      <text
        x="68"
        y="121"
        fontSize="6"
        fill="black"
        opacity="0.45"
      >
        op₂
      </text>

      <path
        d="M92 52H122L145 75"
        stroke="black"
        strokeWidth="1"
      />

      <path
        d="M92 109H122L145 75"
        stroke="black"
        strokeWidth="1"
      />

      <path
        d="M116 48L124 52L116 56"
        stroke="black"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <path
        d="M116 105L124 109L116 113"
        stroke="black"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <circle
        cx="158"
        cy="75"
        r="20"
        fill="white"
        stroke="black"
        strokeWidth="1.2"
      />

      <path
        d="M149 68H167"
        stroke="black"
        strokeWidth="1"
      />

      <path
        d="M149 75H167"
        stroke="black"
        strokeWidth="1"
      />

      <path
        d="M149 82H167"
        stroke="black"
        strokeWidth="1"
      />

      <circle
        cx="153"
        cy="68"
        r="2"
        fill="black"
      />

      <circle
        cx="163"
        cy="75"
        r="2"
        fill="black"
      />

      <circle
        cx="153"
        cy="82"
        r="2"
        fill="black"
      />

      <text
        x="143"
        y="104"
        fontSize="7"
        fill="black"
        opacity="0.5"
      >
        CRDT
      </text>

      <path
        d="M178 75H208"
        stroke="black"
        strokeWidth="1"
      />

      <path
        d="M200 71L208 75L200 79"
        stroke="black"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <rect
        x="208"
        y="40"
        width="100"
        height="70"
        stroke="black"
        strokeWidth="1"
      />

      <text
        x="220"
        y="53"
        fontSize="8"
        fill="black"
        opacity="0.5"
      >
        CONVERGED STATE
      </text>

      <path
        d="M220 65H292"
        stroke="black"
        strokeOpacity="0.25"
      />

      <path
        d="M220 75H282"
        stroke="black"
        strokeOpacity="0.15"
      />

      <path
        d="M220 85H295"
        stroke="black"
        strokeOpacity="0.15"
      />

      <rect
        x="220"
        y="94"
        width="34"
        height="6"
        fill="black"
      />

      <text
        x="261"
        y="100"
        fontSize="6"
        fill="black"
        opacity="0.45"
      >
        same state
      </text>

      <text
        x="10"
        y="146"
        fontSize="7"
        fill="black"
        opacity="0.45"
      >
        concurrent operations → deterministic convergence
      </text>
    </svg>
  );
}

function ShareIllustration() {
  return (
    <svg
      viewBox="0 0 320 150"
      className="h-auto w-full max-w-[300px]"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="55"
        cy="75"
        r="18"
        stroke="black"
        strokeWidth="1"
      />

      <circle cx="55" cy="70" r="4" fill="black" />

      <path
        d="M47 84C49 77 61 77 63 84"
        stroke="black"
        strokeWidth="1.2"
      />

      <circle
        cx="265"
        cy="75"
        r="18"
        stroke="black"
        strokeWidth="1"
      />

      <circle cx="265" cy="70" r="4" fill="black" />

      <path
        d="M257 84C259 77 271 77 273 84"
        stroke="black"
        strokeWidth="1.2"
      />

      <rect
        x="125"
        y="42"
        width="70"
        height="66"
        stroke="black"
        strokeWidth="1.2"
      />

      <path d="M138 59H181" stroke="black" strokeOpacity="0.25" />
      <path d="M138 70H184" stroke="black" strokeOpacity="0.15" />
      <path d="M138 81H173" stroke="black" strokeOpacity="0.15" />

      <path
        d="M142 94H178"
        stroke="black"
        strokeWidth="1.5"
      />

      <circle cx="145" cy="94" r="3" fill="black" />
      <circle cx="175" cy="94" r="3" fill="black" />

      <path
        d="M73 75H125"
        stroke="black"
        strokeWidth="1"
        strokeDasharray="4 4"
      />

      <path
        d="M195 75H247"
        stroke="black"
        strokeWidth="1"
        strokeDasharray="4 4"
      />

      <path
        d="M113 70L123 75L113 80"
        stroke="black"
        strokeWidth="1"
      />

      <path
        d="M207 70L197 75L207 80"
        stroke="black"
        strokeWidth="1"
      />

      <text
        x="132"
        y="127"
        fontSize="8"
        fill="black"
        opacity="0.45"
      >
        shared document
      </text>
    </svg>
  );
}

function HistoryIllustration() {
  return (
    <svg
      viewBox="0 0 320 150"
      className="h-auto w-full max-w-[300px]"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M35 75H285"
        stroke="black"
        strokeOpacity="0.18"
        strokeWidth="1"
      />

      <circle cx="55" cy="75" r="5" fill="black" />
      <circle cx="105" cy="75" r="5" fill="black" />
      <circle cx="155" cy="75" r="5" fill="black" />
      <circle cx="205" cy="75" r="5" fill="black" />

      <circle cx="255" cy="75" r="9" fill="black" />

      <path
        d="M55 70V38"
        stroke="black"
        strokeOpacity="0.2"
      />

      <path
        d="M105 70V105"
        stroke="black"
        strokeOpacity="0.2"
      />

      <path
        d="M155 70V38"
        stroke="black"
        strokeOpacity="0.2"
      />

      <path
        d="M205 70V105"
        stroke="black"
        strokeOpacity="0.2"
      />

      <rect
        x="40"
        y="25"
        width="30"
        height="13"
        fill="black"
        fillOpacity="0.06"
        stroke="black"
        strokeOpacity="0.2"
      />

      <rect
        x="90"
        y="105"
        width="30"
        height="13"
        fill="black"
        fillOpacity="0.06"
        stroke="black"
        strokeOpacity="0.2"
      />

      <rect
        x="140"
        y="25"
        width="30"
        height="13"
        fill="black"
        fillOpacity="0.06"
        stroke="black"
        strokeOpacity="0.2"
      />

      <rect
        x="190"
        y="105"
        width="30"
        height="13"
        fill="black"
        fillOpacity="0.06"
        stroke="black"
        strokeOpacity="0.2"
      />

      <rect
        x="245"
        y="105"
        width="30"
        height="13"
        fill="black"
      />

      <path
        d="M255 52V42"
        stroke="black"
        strokeWidth="1"
      />

      <text
        x="242"
        y="35"
        fontSize="8"
        fill="black"
      >
        HEAD
      </text>

      <text
        x="38"
        y="138"
        fontSize="8"
        fill="black"
        opacity="0.45"
      >
        immutable operations → converged state
      </text>
    </svg>
  );
}

function GalileoCard({ className = "" }: { className?: string }) {
  return (
    <div
      className={`relative flex flex-col overflow-hidden bg-white ${className}`}
    >
      <div className="flex h-full flex-col p-4 sm:p-5 lg:p-6">
        <div>
          <div className="max-w-[380px] text-base font-semibold leading-tight text-black sm:text-lg">
            Everything Between a Keystroke and a Converged Document.
          </div>

          <h3 className="mt-5 max-w-[320px] text-sm leading-[1.5] text-black/70 sm:text-[15px]">
            Type locally. Queue offline. Merge without conflict. Converge
            exactly once.
          </h3>

          <div className="mt-5 flex flex-wrap gap-2">
            <span className="px-2 py-1 text-[9px] uppercase tracking-wide text-black">
              Zero merge conflicts
            </span>

            <span className="px-2 py-1 text-[9px] uppercase tracking-wide text-black">
              Offline-first
            </span>
          </div>
        </div>

        <div className="flex flex-1 items-center py-8">
          <svg
            viewBox="0 0 320 120"
            className="h-auto w-full"
            fill="none"
            aria-hidden="true"
          >
            <path d="M0 20H150" stroke="black" strokeOpacity="0.3" />
            <path d="M0 60H150" stroke="black" strokeOpacity="0.3" />
            <path d="M0 100H150" stroke="black" strokeOpacity="0.3" />

            <circle cx="4" cy="20" r="3.5" fill="black" />
            <circle cx="4" cy="60" r="3.5" fill="black" />
            <circle cx="4" cy="100" r="3.5" fill="black" />

            <path d="M150 20C200 20 200 60 250 60" stroke="black" strokeOpacity="0.5" />
            <path d="M150 100C200 100 200 60 250 60" stroke="black" strokeOpacity="0.5" />
            <path d="M150 60H250" stroke="black" strokeOpacity="0.5" />

            <path d="M250 60H316" stroke="black" strokeWidth="2" />
            <rect x="308" y="52" width="8" height="16" fill="black" />
          </svg>
        </div>

        <div className="mt-auto grid grid-cols-2 gap-2 pt-10">
          <div className="bg-white/70 p-3 backdrop-blur sm:p-4">
            <div className="text-2xl font-medium text-black sm:text-3xl">
              0
            </div>

            <div className="mt-1 text-[8px] uppercase tracking-wide text-zinc-600 sm:text-[9px]">
              Merge conflicts
            </div>
          </div>

          <div className="bg-white/70 p-3 backdrop-blur sm:p-4">
            <div className="text-2xl font-medium text-black sm:text-3xl">
              1
            </div>

            <div className="mt-1 text-[8px] uppercase tracking-wide text-zinc-600 sm:text-[9px]">
              Consistent document
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CTABanner({ onCreateNew }: { onCreateNew?: () => void }) {
  return (
    <div className="relative mt-px overflow-hidden border border-zinc-300 bg-black">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage:
            "radial-gradient(circle,#ffffff 1px,transparent 1px)",
          backgroundSize: "4px 4px",
        }}
      />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-4 top-1/2 hidden h-32 w-32 -translate-y-1/2 opacity-10 sm:right-8 sm:block lg:right-12"
      >
        <div className="absolute left-4 top-2 h-20 w-3 rotate-45 bg-white" />
        <div className="absolute left-12 top-2 h-20 w-3 -rotate-45 bg-white" />
        <div className="absolute left-20 top-2 h-20 w-3 rotate-45 bg-white" />
      </div>

      <div className="relative z-10 p-5 sm:p-7 md:p-8 lg:p-10">
        <h3 className="max-w-[650px] text-[clamp(1.5rem,4vw,2.25rem)] font-medium leading-[1.05] tracking-[-0.035em] text-white">
          Everything Between a Keystroke
          <br className="hidden sm:block" />
          <span className="sm:ml-2">
            and a Converged Document.
          </span>
        </h3>

        <p className="mt-4 max-w-[500px] text-[13px] leading-[1.55] text-zinc-400 sm:text-sm">
          YSync keeps every collaborator&apos;s edits connected, so nothing is
          ever overwritten, dropped, or lost.
        </p>
      </div>
    </div>
  );
}