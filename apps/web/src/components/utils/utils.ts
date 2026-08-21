import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// A helper for combining Tailwind CSS class names safely. `clsx` lets you pass conditional classes and `twMerge` then resolves conflicts between them (e.g. two different "p-2"/"p-4" classes) so the last one wins instead of both being applied.

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
