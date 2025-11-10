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
import { handleJoin } from './interactions/buttons/join.js';
import { handleStatus } from './interactions/buttons/status.js';

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
        if (interaction.isAutocomplete()) {
            const cmd = commands.find(c => c.data.name === interaction.commandName);
            if (cmd?.autocomplete) await cmd.autocomplete(interaction);
            return;
        }

        if (interaction.isChatInputCommand()) {
            const cmd = commands.find(c => c.data.name === interaction.commandName);
            if (cmd) await cmd.run(interaction);
            return;
        }

        // inside interactionCreate:
        if (interaction.isButton()) {
            const btn = interaction;
            const [ns, action, runId] = btn.customId.split(':');

            if (ns !== 'run' || !runId) return;

            if (action === 'org' || action === 'panel') return handleOrganizerPanel(btn, runId);
            if (action === 'join') return handleJoin(btn, runId);
            if (action === 'start') return handleStatus(btn, runId, 'started');
            if (action === 'end') return handleStatus(btn, runId, 'ended');

            return btn.reply({ content: 'Coming soon.', ephemeral: true });
        }
    } catch (e) {
        console.error(e);
        if (interaction.isRepliable?.()) {
            const msg = 'Something went wrong.';
            interaction.deferred || interaction.replied
                ? await interaction.followUp({ content: msg, ephemeral: true })
                : await interaction.reply({ content: msg, ephemeral: true });
        }
    }
});

await client.login(token);
