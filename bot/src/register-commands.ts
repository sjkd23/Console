import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(process.cwd(), '.env') });

import { botConfig } from './config.js';
import { REST } from 'discord.js';
import { registerAll } from './commands/index.js';

const rest = new REST({ version: '10' }).setToken(botConfig.SECRET_KEY);

async function main() {
    const names = await registerAll(rest, botConfig.APPLICATION_ID, botConfig.DISCORD_DEV_GUILD_ID);
    console.log('Registered dev guild commands:', names.join(', '));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
