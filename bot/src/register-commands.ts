import { config } from 'dotenv';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
config({ path: resolve(process.cwd(), '.env') });

import { botConfig } from './config.js';
import { REST } from 'discord.js';
import { registerAll } from './commands/index.js';

const rest = new REST({ version: '10' }).setToken(botConfig.SECRET_KEY);

export async function registerCommands(): Promise<void> {
    console.log(`📝 Registering commands to ${botConfig.GUILD_IDS.length} guild(s)...`);
    
    for (const guildId of botConfig.GUILD_IDS) {
        try {
            const names = await registerAll(rest, botConfig.APPLICATION_ID, guildId);
            console.log(`✅ Guild ${guildId}: Registered ${names.length} commands`);
        } catch (err) {
            console.error(`❌ Guild ${guildId}: Failed to register commands:`, err);
        }
    }
    
    console.log('\n🎉 Command registration complete!');
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
    registerCommands().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
