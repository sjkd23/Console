// src/index.ts
import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(process.cwd(), '.env') });

import {
    Client,
    GatewayIntentBits,
    Partials,
    Interaction,
    ButtonInteraction
} from 'discord.js';
import { commands } from './commands/index.js';
import { handleOrganizerPanel } from './interactions/buttons/organizerPanel.js';

const token = process.env.SECRET_KEY!;
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel, Partials.GuildMember, Partials.User]
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user?.tag}`);
});

client.on('interactionCreate', async (interaction: Interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            const cmd = commands.find(c => c.data.name === interaction.commandName);
            if (cmd) await cmd.run(interaction);
            return;
        }

        if (interaction.isButton()) {
            const btn = interaction as ButtonInteraction;
            const [ns, action, runId] = btn.customId.split(':'); // e.g., "run:org:123"
            if (ns !== 'run' || !action) return;

            if (action === 'org' || action === 'panel') {
                return handleOrganizerPanel(btn, runId);
            }

            // other actions (join/class/start/end/cancel) will be handled later
            return btn.reply({ content: 'Coming soon.', ephemeral: true });
        }
    } catch (e) {
        console.error(e);
        if (interaction.isRepliable()) {
            const msg = 'Something went wrong.';
            interaction.deferred || interaction.replied
                ? await interaction.followUp({ content: msg, ephemeral: true })
                : await interaction.reply({ content: msg, ephemeral: true });
        }
    }
});

await client.login(token);
