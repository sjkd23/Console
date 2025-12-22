import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    EmbedBuilder,
    MessageFlags,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { getGuildChannels } from '../../lib/utilities/http.js';
import { ensureGuildContext, fetchGuildMember } from '../../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../../lib/errors/error-handler.js';
import { handleDungeonAutocomplete } from '../../lib/utilities/dungeon-autocomplete.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import { logCommandExecution } from '../../lib/logging/bot-logger.js';
import { hasActiveParty, checkRateLimit, recordPartyCreation } from '../../lib/state/party-state.js';

/**
 * Party Command
 * Allows verified raiders to create party finder posts to organize their own groups.
 * Features:
 * - Rate limiting (3 parties per 30 minutes)
 * - Active party tracking (1 active party per user)
 * - Automatic thread creation
 * - Party owner controls (close button)
 * - Optional dungeon and location information
 */
export const party: SlashCommand = {
    requiredRole: 'verified_raider',
    data: new SlashCommandBuilder()
        .setName('party')
        .setDescription('Create a party finder post for organizing your own group (Verified Raider+)')
        .addStringOption(o =>
            o.setName('party_name')
                .setDescription('Name of your party')
                .setRequired(true)
        )
        .addStringOption(o =>
            o.setName('description')
                .setDescription('Description of what you\'re planning')
                .setRequired(true)
        )
        .addStringOption(o =>
            o.setName('location')
                .setDescription('Location/server (optional)')
                .setRequired(false)
        )
        .addStringOption(o =>
            o.setName('dungeon_1')
                .setDescription('First dungeon (optional)')
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addStringOption(o =>
            o.setName('dungeon_2')
                .setDescription('Second dungeon (optional)')
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addStringOption(o =>
            o.setName('dungeon_3')
                .setDescription('Third dungeon (optional)')
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addStringOption(o =>
            o.setName('dungeon_4')
                .setDescription('Fourth dungeon (optional)')
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addStringOption(o =>
            o.setName('dungeon_5')
                .setDescription('Fifth dungeon (optional)')
                .setRequired(false)
                .setAutocomplete(true)
        ),

    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            // 1) Ensure guild context
            const guild = await ensureGuildContext(interaction);
            if (!guild) return;

            // Fetch member for context
            const member = await fetchGuildMember(guild, interaction.user.id);
            if (!member) {
                await interaction.reply({
                    content: 'Could not fetch your member information.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            // 2) Check if user already has an active party
            if (hasActiveParty(interaction.user.id)) {
                await interaction.editReply(
                    '❌ **Active Party Exists**\n\n' +
                    'You already have an active party. Please close your current party before creating a new one.'
                );
                await logCommandExecution(interaction.client, interaction, {
                    success: false,
                    errorMessage: 'User already has an active party'
                });
                return;
            }

            // 3) Check rate limit
            const rateLimitCheck = checkRateLimit(interaction.user.id);
            if (!rateLimitCheck.allowed) {
                const nextAvailable = rateLimitCheck.nextAvailableTime ? new Date(rateLimitCheck.nextAvailableTime) : null;
                const timeUntilNext = nextAvailable ? Math.ceil((nextAvailable.getTime() - Date.now()) / 1000 / 60) : 0;
                
                await interaction.editReply(
                    '❌ **Rate Limit Reached**\n\n' +
                    `You can only create 3 parties per 30-minute period.\n` +
                    `Please try again in **${timeUntilNext} minute${timeUntilNext !== 1 ? 's' : ''}**.`
                );
                await logCommandExecution(interaction.client, interaction, {
                    success: false,
                    errorMessage: 'Rate limit exceeded'
                });
                return;
            }

            // 4) Get party_finder channel
            let partyFinderChannelId: string | null = null;
            try {
                const { channels } = await getGuildChannels(guild.id);
                partyFinderChannelId = channels.party_finder || null;
            } catch (err) {
                console.error('[Party] Failed to fetch guild channels:', err);
            }

            if (!partyFinderChannelId) {
                await interaction.editReply(
                    '❌ **Party Finder Not Configured**\n\n' +
                    'This server hasn\'t set up a party finder channel yet.\n\n' +
                    'Ask a server admin to use `/setchannels party_finder:#channel` to configure it.'
                );
                await logCommandExecution(interaction.client, interaction, {
                    success: false,
                    errorMessage: 'Party finder channel not configured'
                });
                return;
            }

            // 5) Fetch the party finder channel
            const partyFinderChannel = await guild.channels.fetch(partyFinderChannelId);
            if (!partyFinderChannel || !partyFinderChannel.isTextBased()) {
                await interaction.editReply('❌ Party finder channel not found or is not a text channel.');
                await logCommandExecution(interaction.client, interaction, {
                    success: false,
                    errorMessage: 'Party finder channel not found'
                });
                return;
            }

            // 6) Get command options and validate
            const partyName = interaction.options.getString('party_name', true);
            const description = interaction.options.getString('description', true);
            const location = interaction.options.getString('location', false);

            // Validate party name length (Discord message content has 2000 char limit)
            if (partyName.length > 200) {
                await interaction.editReply(
                    '❌ **Invalid Input**\n\n' +
                    'Party name must be 200 characters or less.'
                );
                await logCommandExecution(interaction.client, interaction, {
                    success: false,
                    errorMessage: 'Party name too long'
                });
                return;
            }

            // Validate description length (Discord embed description limit is 4096)
            if (description.length > 2000) {
                await interaction.editReply(
                    '❌ **Invalid Input**\n\n' +
                    'Description must be 2000 characters or less.'
                );
                await logCommandExecution(interaction.client, interaction, {
                    success: false,
                    errorMessage: 'Description too long'
                });
                return;
            }

            // Get dungeon options and deduplicate (keep first occurrence only)
            const dungeonCodes: string[] = [];
            const seenDungeons = new Set<string>();
            for (let i = 1; i <= 5; i++) {
                const code = interaction.options.getString(`dungeon_${i}`, false);
                if (code) {
                    const dungeonInfo = dungeonByCode[code];
                    if (dungeonInfo && !seenDungeons.has(dungeonInfo.dungeonName)) {
                        dungeonCodes.push(dungeonInfo.dungeonName);
                        seenDungeons.add(dungeonInfo.dungeonName);
                    }
                }
            }

            // 7) Build the message content (above the embed)
            let messageContent = `**Party:** ${partyName}`;
            if (location) {
                messageContent += ` | **Location:** ${location}`;
            }

            // 8) Build the embed
            // Color codes: 0x57F287 (green) = Open, 0xED4245 (red) = Closed
            const embed = new EmbedBuilder()
                .setTitle('✅ Party Open') 
                .setDescription(description)
                .setColor(0x57F287) // Green for Open
                .setTimestamp();

            // Add dungeons field if any were specified
            if (dungeonCodes.length > 0) {
                embed.addFields({
                    name: 'Dungeons',
                    value: dungeonCodes.map(d => `• ${d}`).join('\n'),
                    inline: false
                });
            }

            // Add party leader field
            embed.addFields({
                name: 'Party Owner',
                value: `<@${interaction.user.id}>`,
                inline: true
            });

            // Create Close Button
            // Custom ID format: party:close:{userId} - parsed in party-actions.ts
            const closeButton = new ButtonBuilder()
                .setCustomId(`party:close:${interaction.user.id}`)
                .setLabel('Close')
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(closeButton);

            // 9) Send the party post to party finder channel
            try {
                const message = await partyFinderChannel.send({
                    content: messageContent,
                    embeds: [embed],
                    components: [row]
                });

                // Record party creation
                recordPartyCreation(interaction.user.id, message.id);

                // Start a thread
                // Auto-archive after 60 minutes of inactivity
                // Thread name is truncated to 100 chars max (Discord limit)
                try {
                    const threadName = partyName.length > 100 ? partyName.substring(0, 97) + '...' : partyName;
                    await message.startThread({
                        name: threadName,
                        autoArchiveDuration: 60,
                    });
                } catch (threadErr) {
                    console.error('[Party] Failed to create thread:', threadErr);
                }

                await interaction.editReply(
                    `✅ Party posted successfully!\n\n${message.url}`
                );

                await logCommandExecution(interaction.client, interaction, { success: true });
            } catch (err) {
                console.error('[Party] Failed to send party post:', err);
                await interaction.editReply('❌ Failed to post party. Please try again.');
                await logCommandExecution(interaction.client, interaction, {
                    success: false,
                    errorMessage: 'Failed to send party post'
                });
            }

        } catch (err) {
            const errorMessage = formatErrorMessage({
                error: err,
                baseMessage: 'Failed to create party',
            });
            
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(errorMessage);
            } else {
                await interaction.reply({
                    content: errorMessage,
                    flags: MessageFlags.Ephemeral,
                });
            }
            
            await logCommandExecution(interaction.client, interaction, {
                success: false,
                errorMessage: err instanceof Error ? err.message : String(err)
            });
        }
    },

    // Autocomplete handler for dungeon options
    async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
        // Handle all dungeon fields (dungeon_1 through dungeon_5)
        await handleDungeonAutocomplete(interaction, ['dungeon_1', 'dungeon_2', 'dungeon_3', 'dungeon_4', 'dungeon_5']);
    }
};
