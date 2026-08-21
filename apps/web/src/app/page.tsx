"use client"; 

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Hero } from "../components/landing/hero";
import { WorkFlow } from "../components/landing/workflow";
import ProcessSection from "../components/landing/process";
import CaseStudiesSection from "../components/landing/case-studies";
import TestimonialBanner from "../components/landing/testimonial-banner";
import ReplyRateSection from "../components/landing/reply-rate";
import GroundworkEngineSection from "../components/landing/work-engine";
import FAQSection from "../components/landing/faqs";
import { GroundworkFooter } from "../components/landing/footer";

export default function HomePage() {
  const router = useRouter();
  const [slugInput, setSlugInput] = useState("");

  function createNew(): void {
    const slug = crypto.randomUUID().slice(0, 8);
    router.push(`/doc/${slug}`);
  }

  function joinExisting(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const slug = slugInput.trim();
    if (slug) router.push(`/doc/${slug}`);
  }

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <main className="w-full flex-1">
        <Hero
          onCreateNew={createNew}
          slugInput={slugInput}
          onSlugChange={setSlugInput}
          onJoin={joinExisting}
        />
        <div id="how-it-works">
          <WorkFlow />
        </div>
        <ProcessSection />
        <div id="capabilities">
          <CaseStudiesSection onCreateNew={createNew} />
        </div>
        <TestimonialBanner />
        <ReplyRateSection />
        <GroundworkEngineSection onCreateNew={createNew} />
        <FAQSection />
      </main>

      <GroundworkFooter />
    </div>
  );
}
