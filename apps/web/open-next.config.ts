import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// defaults are enough for this app — no KV/R2/D1 bindings or custom incremental cache needed yet
export default defineCloudflareConfig();