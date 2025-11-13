import 'dotenv/config';
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  BACKEND_API_KEY: z.string().min(1, "BACKEND_API_KEY is required (shared secret for bot -> backend)"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
