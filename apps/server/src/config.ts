// Production mein REDIS_URL/DATABASE_URL missing hone pe silently localhost
// try karne se pehle isse loudly fail karna behtar hai — localhost kabhi kaam
// nahi karega ek Cloud Run container ke andar, aur woh error message
// (connection refused) asli wajah (secret/env missing) se zyada confusing
// hota hai.
export function resolveRequiredUrl(varName: string, value: string | undefined, devFallback: string): string {
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${varName} is required in production and was not set`);
  }
  return devFallback;
}
