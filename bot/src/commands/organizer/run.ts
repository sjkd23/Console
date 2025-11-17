import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    type GuildTextBasedChannel
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { getMemberRoleIds } from '../../lib/permissions/permissions.js';
import { postJSON, getGuildChannels, getDungeonRolePings, getActiveRunsByOrganizer } from '../../lib/utilities/http.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import { addRecentDungeon } from '../../lib/dungeon/dungeon-cache.js';
import { getReactionInfo } from '../../constants/emojis/MappedAfkCheckReactions.js';
import { ensureGuildContext, fetchGuildMember } from '../../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../../lib/errors/error-handler.js';
import { handleDungeonAutocomplete } from '../../lib/dungeon/dungeon-autocomplete.js';
import { formatKeyLabel } from '../../lib/utilities/key-emoji-helpers.js';
import { logRaidCreation } from '../../lib/logging/raid-logger.js';
import { createRunRole } from '../../lib/utilities/run-role-manager.js';
import { createLogger } from '../../lib/logging/logger.js';
import { getDefaultAutoEndMinutes } from '../../config/raid-config.js';
import { addRunReactions } from '../../lib/utilities/run-reactions.js';
import { hasActiveHeadcount, getActiveHeadcount } from '../../lib/state/active-headcount-tracker.js';

const logger = createLogger('RunCreate');

export const runCreate: SlashCommand = {
    requiredRole: 'organizer',
    data: new SlashCommandBuilder()
        .setName('run')
        .setDescription('Create a new run (posts to this channel).')
        .addStringOption(o =>
            o.setName('dungeon')
                .setDescription('Choose a dungeon')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(o =>
            o.setName('party').setDescription('Party name (optional)')
        )
        .addStringOption(o =>
            o.setName('location').setDescription('Location/server (optional)')
        )
        .addStringOption(o =>
            o.setName('description').setDescription('Run description (optional)')
        ),

    // Slash action
    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        const guild = await ensureGuildContext(interaction);
        if (!guild) return;

        // Fetch member for role IDs (permission check done by middleware)
        const member = await fetchGuildMember(guild, interaction.user.id);
        if (!member) {
            await interaction.reply({
                content: 'Could not fetch your member information.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const codeName = interaction.options.getString('dungeon', true);
        const d = dungeonByCode[codeName];

        if (!d) {
            await interaction.reply({
                content: 'Unknown dungeon name. Try again.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const desc = interaction.options.getString('description') || undefined;
        const party = interaction.options.getString('party') || undefined;
        const location = interaction.options.getString('location') || undefined;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Check if organizer has any active runs (open or live)
        try {
            const { activeRuns } = await getActiveRunsByOrganizer(guild.id, interaction.user.id);
            
            if (activeRuns.length > 0) {
                // Organizer already has active run(s) - prevent creating a new one
                const activeRun = activeRuns[0]; // Show details of the first active run
                
                // Build message link if we have both channel and message IDs
                let runLink = '';
                if (activeRun.channelId && activeRun.postMessageId) {
                    runLink = `https://discord.com/channels/${guild.id}/${activeRun.channelId}/${activeRun.postMessageId}`;
                }
                
                let message = `⚠️ **You already have an active run**\n\n`;
                message += `**Dungeon:** ${activeRun.dungeonLabel}\n`;
                message += `**Status:** ${activeRun.status === 'open' ? '⏳ Starting Soon' : '🔴 Live'}\n`;
                message += `**Created:** <t:${Math.floor(new Date(activeRun.createdAt).getTime() / 1000)}:R>\n\n`;
                
                if (runLink) {
                    message += `[Jump to Run](${runLink})\n\n`;
                }
                
                message += `Please end or cancel your current run before starting a new one.\n\n`;
                message += `**To end your run:**\n`;
                message += `• Click the "Organizer Panel" button on your active run\n`;
                message += `• Use the "End Run" or "Cancel Run" button\n\n`;
                message += `*If your run is glitched and you can't end it, contact a server admin for help.*`;
                
                await interaction.editReply(message);
                return;
            }
        } catch (err) {
            // Log the error but don't block run creation if the check fails
            logger.error('Failed to check for active runs', {
                guildId: guild.id,
                organizerId: interaction.user.id,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined
            });
            // Continue with run creation - don't let API failures block legitimate runs
        }

        // Check if organizer has an active headcount
        if (hasActiveHeadcount(guild.id, interaction.user.id)) {
            const activeHeadcount = getActiveHeadcount(guild.id, interaction.user.id);
            if (activeHeadcount) {
                const headcountLink = `https://discord.com/channels/${guild.id}/${activeHeadcount.channelId}/${activeHeadcount.messageId}`;
                
                let message = `⚠️ **You have an active headcount**\n\n`;
                message += `**Dungeons:** ${activeHeadcount.dungeons.join(', ')}\n`;
                message += `**Created:** <t:${Math.floor(activeHeadcount.createdAt.getTime() / 1000)}:R>\n\n`;
                message += `[Jump to Headcount](${headcountLink})\n\n`;
                message += `Please end your headcount before starting a run.\n\n`;
                message += `**To end your headcount:**\n`;
                message += `• Click the "Organizer Panel" button on your active headcount\n`;
                message += `• Use the "End Headcount" button`;
                
                await interaction.editReply(message);
                return;
            }
        }

        // Track this dungeon as recently used for this guild
        addRecentDungeon(guild.id, codeName);

        // Create the temporary role for this run
        const role = await createRunRole(guild, interaction.user.username, d.dungeonName);
        if (!role) {
            await interaction.editReply(
                '**Warning:** Failed to create the run role. The run will still be created, but members won\'t be automatically assigned a role.'
            );
            // Continue anyway - role creation failure shouldn't block run creation
        }

        // Must be in a guild context
        if (!interaction.inGuild()) {
            await interaction.editReply(
                'This command can only be used in a server.'
            );
            return;
        }

        // Get the configured raid channel
        const { channels } = await getGuildChannels(guild.id);
        const raidChannelId = channels.raid;

        if (!raidChannelId) {
            await interaction.editReply(
                '**Error:** No raid channel is configured. Ask an admin to set one up with `/setchannels`.'
            );
            return;
        }

        // Fetch the raid channel
        let raidChannel: GuildTextBasedChannel;
        try {
            const fetchedChannel = await interaction.client.channels.fetch(raidChannelId);
            if (!fetchedChannel || !fetchedChannel.isTextBased() || fetchedChannel.isDMBased()) {
                await interaction.editReply(
                    '**Error:** The raid channel is invalid or inaccessible. Ask an admin to reconfigure it with `/setchannels`.'
                );
                return;
            }
            raidChannel = fetchedChannel as GuildTextBasedChannel;
        } catch (err) {
            logger.error('Failed to fetch raid channel', { 
                guildId: guild.id, 
                raidChannelId,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined
            });
            await interaction.editReply(
                '**Error:** Can\'t access the raid channel. It may have been deleted. Ask an admin to reconfigure it with `/setchannels`.'
            );
            return;
        }

        // Create DB run with the correct raid channel ID
        try {
            const { runId } = await postJSON<{ runId: number }>('/runs', {
                guildId: guild.id,
                guildName: guild.name,
                organizerId: interaction.user.id,
                organizerUsername: interaction.user.username,
                organizerRoles: getMemberRoleIds(member),
                channelId: raidChannelId, // Use the configured raid channel ID
                dungeonKey: d.codeName,      // stable key in DB
                dungeonLabel: d.dungeonName, // human label in DB
                description: desc,
                party,
                location,
                autoEndMinutes: getDefaultAutoEndMinutes(),
                roleId: role?.id // Store the created role ID
            }, { guildId: guild.id });

            // Build the public embed (Starting/Lobby phase)
            const embed = new EmbedBuilder()
                .setTitle(`⏳ Starting Soon: ${d.dungeonName}`)
                .setDescription(`Organizer: <@${interaction.user.id}>`)
                .addFields(
                    { name: 'Raiders', value: '0', inline: false }
                )
                .setTimestamp(new Date());

            // Add Keys field if the dungeon has key reactions
            if (d.keyReactions && d.keyReactions.length > 0) {
                embed.addFields({ name: 'Keys', value: 'No keys reported', inline: false });
            }

            // Add Organizer Note field if description provided
            if (desc) {
                embed.addFields({
                    name: 'Organizer Note',
                    value: desc,
                    inline: false
                });
            }

            // Color & thumbnail if present
            if (d.dungeonColors?.length) embed.setColor(d.dungeonColors[0]);
            if (d.portalLink?.url) embed.setThumbnail(d.portalLink.url);

            // Public buttons + organizer panel opener
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`run:join:${runId}`)
                    .setLabel('Join')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`run:leave:${runId}`)
                    .setLabel('Leave')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`run:org:${runId}`)
                    .setLabel('Organizer Panel')
                    .setStyle(ButtonStyle.Secondary)
            );

            // Key buttons based on dungeon type
            const keyRows: ActionRowBuilder<ButtonBuilder>[] = [];
            if (d.keyReactions && d.keyReactions.length > 0) {
                // Group key buttons into rows of up to 5 buttons each
                const keyButtons: ButtonBuilder[] = [];
                for (const keyReaction of d.keyReactions) {
                    const reactionInfo = getReactionInfo(keyReaction.mapKey);
                    const button = new ButtonBuilder()
                        .setCustomId(`run:key:${runId}:${keyReaction.mapKey}`)
                        .setLabel(formatKeyLabel(keyReaction.mapKey))
                        .setStyle(ButtonStyle.Secondary);
                    
                    // Add emoji if available
                    if (reactionInfo?.emojiInfo?.identifier) {
                        button.setEmoji(reactionInfo.emojiInfo.identifier);
                    }
                    
                    keyButtons.push(button);
                }

                // Split into rows of up to 5 buttons
                for (let i = 0; i < keyButtons.length; i += 5) {
                    const rowButtons = keyButtons.slice(i, i + 5);
                    keyRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...rowButtons));
                }
            }

            // Build message content with party/location if provided
            let content = '@here';
            
            // Check if there's a configured role ping for this dungeon
            try {
                const { dungeon_role_pings } = await getDungeonRolePings(guild.id);
                const roleId = dungeon_role_pings[codeName];
                if (roleId) {
                    content += ` <@&${roleId}>`;
                }
            } catch (e) {
                logger.warn('Failed to fetch dungeon role pings', { 
                    guildId: guild.id, 
                    dungeonCode: codeName,
                    error: e instanceof Error ? e.message : String(e)
                });
                // Continue without custom role ping
            }
            
            // Don't show party/location in message content until run goes live

            const sent = await raidChannel.send({
                content,
                embeds: [embed],
                components: [row, ...keyRows]
            });

            // NEW: tell backend the message id we just posted
            try {
                await postJSON(`/runs/${runId}/message`, { postMessageId: sent.id }, { guildId: guild.id });
            } catch (e) {
                logger.error('Failed to store post_message_id', { 
                    guildId: guild.id,
                    runId: runId,
                    messageId: sent.id,
                    error: e instanceof Error ? e.message : String(e)
                });
            }

            // Add reactions to the run message based on dungeon configuration
            try {
                await addRunReactions(sent, d.codeName);
            } catch (e) {
                logger.error('Failed to add reactions to run message', {
                    guildId: guild.id,
                    runId: runId,
                    messageId: sent.id,
                    dungeonKey: d.codeName,
                    error: e instanceof Error ? e.message : String(e)
                });
                // Don't fail the command if reactions fail - continue with run creation
            }

            // Log the run creation to raid-log channel
            try {
                await logRaidCreation(
                    interaction.client,
                    {
                        guildId: guild.id,
                        organizerId: interaction.user.id,
                        organizerUsername: interaction.user.username,
                        dungeonName: d.dungeonName,
                        type: 'run',
                        runId: runId
                    },
                    {
                        party,
                        location,
                        description: desc
                    }
                );
            } catch (e) {
                logger.error('Failed to log run creation to raid-log', { 
                    guildId: guild.id,
                    runId: runId,
                    dungeonName: d.dungeonName,
                    error: e instanceof Error ? e.message : String(e)
                });
            }

            await interaction.editReply(
                `Run created${sent ? ` and posted: ${sent.url}` : ''}`
            );
        } catch (err) {
            const errorMessage = formatErrorMessage({
                error: err,
                baseMessage: 'Failed to create run',
                errorHandlers: {
                    'NOT_ORGANIZER': '**Issue:** You don\'t have the Organizer role configured for this server.\n\n**What to do:**\n• Ask a server admin to use `/setroles` to set up the Organizer role\n• Make sure you have the Discord role that\'s mapped to Organizer\n• Once roles are configured, try creating your run again',
                },
            });
            await interaction.editReply(errorMessage);
        }
    },

    // Autocomplete handler
    async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
        await handleDungeonAutocomplete(interaction);
    }
};
