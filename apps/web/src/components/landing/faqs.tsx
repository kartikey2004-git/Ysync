"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Plus, Minus } from "lucide-react";
import { Faq, faqs } from "@/lib/landing-data";

export default function FAQSection() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section className="relative overflow-hidden bg-[#fafafa] py-20">
      <div
        className="absolute inset-0 opacity-50"
        style={{
          backgroundImage: "radial-gradient(#d4d4d4 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
      />

      <div className="relative w-full border border-zinc-300 bg-[#f8f8f8]">
        <div className="grid md:grid-cols-2">
          <div className="relative min-h-[540px] overflow-hidden border-r border-zinc-300 p-6 md:p-8">
            <h2 className="max-w-xs text-4xl font-medium leading-[0.95] tracking-tight text-black">
              Have questions?
              <br />
              We got answers
            </h2>
          </div>

          <div>
            {faqs.map((faq: Faq, index) => {
              const isOpen = open === index;

              return (
                <div key={index} className="border-b border-zinc-300">
                  <button
                    onClick={() => setOpen(isOpen ? null : index)}
                    className="flex w-full items-center justify-between px-4 py-5 text-left transition-colors hover:bg-black/[0.02]"
                  >
                    <span className="pr-6 text-md font-medium text-black">
                      {faq.question}
                    </span>

                    {isOpen ? (
                      <Minus size={16} className="text-zinc-500" />
                    ) : (
                      <Plus size={16} className="text-zinc-500" />
                    )}
                  </button>

                  <AnimatePresence>
                    {isOpen && (
                      <motion.div
                        initial={{
                          height: 0,
                          opacity: 0,
                        }}
                        animate={{
                          height: "auto",
                          opacity: 1,
                        }}
                        exit={{
                          height: 0,
                          opacity: 0,
                        }}
                        transition={{
                          duration: 0.25,
                        }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 pb-5 text-sm leading-relaxed text-zinc-600">
                          {faq.answer}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
