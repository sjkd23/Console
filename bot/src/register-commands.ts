import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(process.cwd(), '.env') });

import { botConfig } from './config.js';
import { REST } from 'discord.js';
import { registerAll } from './commands/index.js';

const rest = new REST({ version: '10' }).setToken(botConfig.SECRET_KEY);

async function main() {
    // Check if --global flag is passed
    const isGlobal = process.argv.includes('--global');
    
    if (isGlobal) {
        // Register commands globally (available to all servers)
        console.log('🌍 Registering commands globally...');
        const names = await registerAll(rest, botConfig.APPLICATION_ID);
        console.log('📝 Commands:', names.join(', '));
        console.log('⏳ Global commands may take up to 1 hour to appear in all servers');
    } else {
        // Register commands to dev guild only (for testing)
        console.log(`🔧 Registering commands to dev guild (${botConfig.DISCORD_DEV_GUILD_ID})...`);
        const names = await registerAll(rest, botConfig.APPLICATION_ID, botConfig.DISCORD_DEV_GUILD_ID);
        console.log('📝 Commands:', names.join(', '));
        console.log('✅ Dev guild commands registered (instant)');
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
