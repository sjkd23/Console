import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(process.cwd(), '.env') });

import { REST } from 'discord.js';
import { registerAll } from './commands/index.js';

const token = process.env.SECRET_KEY!;
const appId = process.env.APPLICATION_ID!;
const guildId = process.env.DISCORD_DEV_GUILD_ID!;

const rest = new REST({ version: '10' }).setToken(token);

async function main() {
    const names = await registerAll(rest, appId, guildId);
    console.log('Registered dev guild commands:', names.join(', '));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
