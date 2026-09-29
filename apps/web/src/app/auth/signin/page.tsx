"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

export default function SignInPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect") ?? "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const { error: authError } = await authClient.signIn.email({
      email,
      password,
    });

    if (authError) {
      setError(authError.message ?? "Sign in failed");
      setLoading(false);
      return;
    }

    router.push(redirect);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <h2 className="text-lg font-medium text-black">Sign in</h2>

      {error && (
        <p className="border-l-2 border-black bg-neutral-50 px-3 py-2 text-sm text-black">
          {error}
        </p>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Email
        </span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="border border-neutral-300 bg-white px-3 py-2 text-sm text-black outline-none transition focus:border-black"
          placeholder="you@example.com"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Password
        </span>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border border-neutral-300 bg-white px-3 py-2 text-sm text-black outline-none transition focus:border-black"
          placeholder="Password"
        />
      </label>

      <button
        type="submit"
        disabled={loading}
        className="border border-black bg-black px-4 py-2 text-sm font-medium uppercase tracking-wider text-white transition hover:bg-neutral-800 disabled:opacity-50"
      >
        {loading ? "Signing in..." : "Sign in"}
      </button>

      <p className="text-center text-sm text-neutral-500">
        No account?{" "}
        <Link href="/auth/signup" className="text-black underline underline-offset-2">
          Sign up
        </Link>
      </p>
    </form>
  );
}
