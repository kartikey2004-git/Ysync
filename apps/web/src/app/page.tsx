"use client";

import { useState, type SubmitEvent } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();
  const [slugInput, setSlugInput] = useState("");

  function createNew(): void {
    const slug = crypto.randomUUID().slice(0, 8);
    router.push(`/doc/${slug}`);
  }

  function joinExisting(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const slug = slugInput.trim();
    if (slug) router.push(`/doc/${slug}`);
  }

  return (
    <main className="landing">
      <h1>YSync</h1>
      <p>A real-time collaborative text editor built on a custom sequence CRDT.</p>
      <button onClick={createNew} className="primary-button">
        Start a new document
      </button>
      <form onSubmit={joinExisting} className="join-form">
        <input
          value={slugInput}
          onChange={(event) => setSlugInput(event.target.value)}
          placeholder="or enter an existing document id"
        />
        <button type="submit">Join</button>
      </form>
    </main>
  );
}
