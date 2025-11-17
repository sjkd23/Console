import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(process.cwd(), '.env') });

import { botConfig } from './config.js';
import { REST } from 'discord.js';
import { registerAll } from './commands/index.js';

const rest = new REST({ version: '10' }).setToken(botConfig.SECRET_KEY);

async function main() {
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

main().catch(err => {
    console.error(err);
    process.exit(1);
});
