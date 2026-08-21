export function GroundworkFooter() {
  return (
    <footer className="bg-black text-white">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-2 px-4 py-12 sm:px-6 lg:px-10">
        <span className="text-base font-bold text-white">YSync</span>
        <p className="text-sm text-white/70">
          Real-time collaborative editing, built on a real CRDT.
        </p>
      </div>
    </footer>
  );
}
