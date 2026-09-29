"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

export default function SignUpPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);

    const { error: authError } = await authClient.signUp.email({
      name,
      email,
      password,
    });

    if (authError) {
      setError(authError.message ?? "Sign up failed");
      setLoading(false);
      return;
    }

    router.push("/dashboard");
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <h2 className="text-lg font-medium text-black">Create account</h2>

      {error && (
        <p className="border-l-2 border-black bg-neutral-50 px-3 py-2 text-sm text-black">
          {error}
        </p>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Name
        </span>
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="border border-neutral-300 bg-white px-3 py-2 text-sm text-black outline-none transition focus:border-black"
          placeholder="Your name"
        />
      </label>

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
          placeholder="Min 8 characters"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Confirm password
        </span>
        <input
          type="password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="border border-neutral-300 bg-white px-3 py-2 text-sm text-black outline-none transition focus:border-black"
          placeholder="Repeat password"
        />
      </label>

      <button
        type="submit"
        disabled={loading}
        className="border border-black bg-black px-4 py-2 text-sm font-medium uppercase tracking-wider text-white transition hover:bg-neutral-800 disabled:opacity-50"
      >
        {loading ? "Creating account..." : "Sign up"}
      </button>

      <p className="text-center text-sm text-neutral-500">
        Already have an account?{" "}
        <Link href="/auth/signin" className="text-black underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </form>
  );
}
