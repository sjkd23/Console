import assert from 'node:assert/strict';
import { GatewayIntentBits, Partials } from 'discord.js';

process.env.APPLICATION_ID = '100000000000000000';
process.env.SECRET_KEY = 'module-load-check-do-not-use';
process.env.DISCORD_GUILD_IDS = '100000000000000001';
process.env.BACKEND_URL = 'http://backend:4000/v1';
process.env.BACKEND_API_KEY = 'module-load-check-do-not-use';
process.env.NODE_ENV = 'production';

const { client } = await import('../index.js');
await import('../register-commands.js');

assert.ok(client.options.intents.has(GatewayIntentBits.GuildMessages));
assert.ok(client.options.intents.has(GatewayIntentBits.MessageContent));
assert.ok(client.options.partials?.includes(Partials.Message));

client.destroy();

console.log('Compiled bot and registration module graphs loaded successfully.');
process.exit(0);
