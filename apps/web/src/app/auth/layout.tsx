export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-medium tracking-tight text-black">YSync</h1>
          <p className="mt-1 text-xs uppercase tracking-[0.22em] text-neutral-500">
            Collaborative editing
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
