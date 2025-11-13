import 'dotenv/config';
import { z } from "zod";

const EnvSchema = z.object({
    APPLICATION_ID: z.string().min(1, "APPLICATION_ID is required (Discord application ID)"),
    SECRET_KEY: z.string().min(1, "SECRET_KEY is required (bot token)"),
    DISCORD_DEV_GUILD_ID: z.string().min(1, "DISCORD_DEV_GUILD_ID is required (your test server ID)"),
    BACKEND_URL: z.string().url("BACKEND_URL must be a valid URL (e.g. http://backend:4000/v1)"),
    BACKEND_API_KEY: z.string().min(1, "BACKEND_API_KEY is required (must match backend)"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type BotConfig = z.infer<typeof EnvSchema>;

export const loadBotConfig = (): BotConfig => {
    const parsed = EnvSchema.safeParse(process.env);

    if (!parsed.success) {
        console.error("❌ Invalid bot environment configuration:");
        for (const issue of parsed.error.issues) {
            console.error(`- ${issue.path.join(".")}: ${issue.message}`);
        }
        process.exit(1);
    }

    return parsed.data;
};

export const botConfig = loadBotConfig();
