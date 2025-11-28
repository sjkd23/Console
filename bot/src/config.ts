import 'dotenv/config';
import { z } from "zod";

const EnvSchema = z.object({
    APPLICATION_ID: z.string().min(1, "APPLICATION_ID is required (Discord application ID)"),
    SECRET_KEY: z.string().min(1, "SECRET_KEY is required (bot token)"),
    DISCORD_GUILD_IDS: z.string().min(1, "DISCORD_GUILD_IDS is required (comma-separated list of server IDs)"),
    BACKEND_URL: z.string().url("BACKEND_URL must be a valid URL (e.g. http://backend:4000/v1)"),
    BACKEND_API_KEY: z.string().min(1, "BACKEND_API_KEY is required (must match backend)"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    
    // Member fetching configuration (optional)
    MEMBER_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10000), // 10 seconds default
    MEMBER_CACHE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.95), // 95% threshold for cache freshness
    MEMBER_FETCH_BACKOFF_MS: z.coerce.number().int().positive().default(300000), // 5 minutes backoff after timeout (default: 300000ms)
});

type EnvConfig = z.infer<typeof EnvSchema>;

export type BotConfig = EnvConfig & {
    GUILD_IDS: string[]; // Parsed array of guild IDs
};

export const loadBotConfig = (): BotConfig => {
    const parsed = EnvSchema.safeParse(process.env);

    if (!parsed.success) {
        console.error("❌ Invalid bot environment configuration:");
        for (const issue of parsed.error.issues) {
            console.error(`- ${issue.path.join(".")}: ${issue.message}`);
        }
        process.exit(1);
    }

    // Parse comma-separated guild IDs
    const guildIds = parsed.data.DISCORD_GUILD_IDS
        .split(',')
        .map(id => id.trim())
        .filter(id => id.length > 0);

    if (guildIds.length === 0) {
        console.error("❌ Invalid bot environment configuration:");
        console.error("- DISCORD_GUILD_IDS: At least one guild ID is required");
        process.exit(1);
    }

    return {
        ...parsed.data,
        GUILD_IDS: guildIds,
    };
};

export const botConfig = loadBotConfig();
