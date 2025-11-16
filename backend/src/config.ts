import 'dotenv/config';
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  BACKEND_API_KEY: z.string().min(1, "BACKEND_API_KEY is required (shared secret for bot -> backend)"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Rate limiting: Global defaults (generous to not interfere with normal bot usage)
  // These catch obviously abusive traffic (leaked keys, infinite loops, etc.) but won't bother normal raids.
  // Default 600/min = 10 req/sec allows multiple concurrent raids to operate smoothly.
  // Per-route limits (HIGH_TRAFFIC=800, MODERATE=180) override this for specific endpoints.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600), // max requests per window
  RATE_LIMIT_TIME_WINDOW_MS: z.coerce.number().int().positive().default(60000), // 1 minute
});

export type BackendConfig = z.infer<typeof EnvSchema>;

export const loadBackendConfig = (): BackendConfig => {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error("❌ Invalid backend environment configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`- ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  return parsed.data;
};

export const backendConfig = loadBackendConfig();
