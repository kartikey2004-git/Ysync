// Better to fail loudly here than silently try localhost when REDIS_URL/DATABASE_URL is missing in production — localhost will never work inside a Cloud Run container, and that error (connection refused) is more confusing than the real cause (missing secret/env).
export function resolveRequiredUrl(varName: string, value: string | undefined, devFallback: string): string {
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${varName} is required in production and was not set`);
  }
  return devFallback;
}
