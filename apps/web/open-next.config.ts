import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// is app ke liye defaults hi kaafi hain — abhi KV/R2/D1 bindings ya custom incremental cache ki zaroorat nahi
export default defineCloudflareConfig();