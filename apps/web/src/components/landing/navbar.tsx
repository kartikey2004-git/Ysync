const LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#process", label: "Process" },
  { href: "#features", label: "Features" },
  { href: "#faq", label: "FAQ" },
];

export function LandingNav() {
  return (
    <header className="sticky top-0 z-50 border-b border-black/10 bg-white">
      <nav
        aria-label="Landing sections"
        className="mx-auto flex h-14 w-full max-w-[1400px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-10"
      >
        <a href="#" className="text-sm font-semibold tracking-tight text-black">
          YSync
        </a>

        <ul className="flex items-center gap-4 text-xs text-neutral-600 sm:gap-6 sm:text-sm">
          {LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="transition-colors hover:text-black focus-visible:text-black focus-visible:outline-none"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
