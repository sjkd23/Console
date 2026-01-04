import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { getMemberRoleIds } from '../../lib/permissions/permissions.js';
import { postJSON, getDungeonRolePings } from '../../lib/utilities/http.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import { addRecentDungeon } from '../../lib/utilities/dungeon-cache.js';
import { getReactionInfo } from '../../constants/emojis/MappedAfkCheckReactions.js';
import { ensureGuildContext, fetchGuildMember } from '../../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../../lib/errors/error-handler.js';
import { handleDungeonAutocomplete } from '../../lib/utilities/dungeon-autocomplete.js';
import { formatKeyLabel } from '../../lib/utilities/key-emoji-helpers.js';
import { logRaidCreation } from '../../lib/logging/raid-logger.js';
import { createRunRole } from '../../lib/utilities/run-role-manager.js';
import { createLogger } from '../../lib/logging/logger.js';
import { getDefaultAutoEndMinutes } from '../../config/raid-config.js';
import { addRunReactions } from '../../lib/utilities/run-reactions.js';
import { checkOrganizerActiveActivities } from '../../lib/utilities/organizer-activity-checker.js';
import { fetchConfiguredRaidChannel } from '../../lib/utilities/channel-helpers.js';
import { sendRunOrganizerPanelAsFollowUp } from '../../interactions/buttons/raids/organizer-panel.js';
import { buildRunEmbed, buildRunButtons } from '../../lib/utilities/run-panel-builder.js';
import { autoJoinOrganizerToRun } from '../../lib/utilities/auto-join-helpers.js';
import { sendEarlyLocNotification } from '../../lib/utilities/early-loc-notifier.js';

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
        // CRITICAL: Defer immediately to prevent timeout under load
        // All validation and async work happens after deferring
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guild = await ensureGuildContext(interaction);
        if (!guild) return;

        // Fetch member for role IDs (permission check done by middleware)
        const member = await fetchGuildMember(guild, interaction.user.id);
        if (!member) {
            await interaction.editReply('Could not fetch your member information.');
            return;
        }

        const codeName = interaction.options.getString('dungeon', true);
        const d = dungeonByCode[codeName];

        if (!d) {
            await interaction.editReply('Unknown dungeon name. Try again.');
            return;
        }

        const desc = interaction.options.getString('description') || undefined;
        const party = interaction.options.getString('party') || undefined;
        const location = interaction.options.getString('location') || undefined;

        // Check if organizer has any active runs or headcounts
        const activityCheck = await checkOrganizerActiveActivities(interaction, guild.id, interaction.user.id);
        if (activityCheck.errorMessage) {
            await interaction.editReply(activityCheck.errorMessage);
            return;
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

        // Get the configured raid channel using helper
        const raidChannel = await fetchConfiguredRaidChannel(guild, interaction);
        if (!raidChannel) {
            // Error already sent by helper
            return;
        }

        // Create DB run with the correct raid channel ID
        try {
            const createResponse = await postJSON<{ runId: number; earlyLocNotification?: any }>('/runs', {
                guildId: guild.id,
                guildName: guild.name,
                organizerId: interaction.user.id,
                organizerUsername: interaction.user.username,
                organizerRoles: getMemberRoleIds(member),
                channelId: raidChannel.id, // Use the configured raid channel ID
                dungeonKey: d.codeName,      // stable key in DB
                dungeonLabel: d.dungeonName, // human label in DB
                description: desc,
                party,
                location,
                autoEndMinutes: getDefaultAutoEndMinutes(),
                roleId: role?.id // Store the created role ID
            }, { guildId: guild.id });

            const runId = createResponse.runId;
            const earlyLocNotification = createResponse.earlyLocNotification;

            // Build the public embed and buttons using universal helpers
            const embed = buildRunEmbed({
                dungeonData: d,
                organizerId: interaction.user.id,
                status: 'starting',
                description: desc
            });

            const components = buildRunButtons({
                runId: runId,
                dungeonData: d,
                joinLocked: false // New runs start with join unlocked
            });

            // Build message content with @here and dungeon role pings
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

            const sent = await raidChannel.send({
                content,
                embeds: [embed],
                components: components
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

            // Reply immediately with the run link (before reactions are added)
            await interaction.editReply(
                `Run created${sent ? ` and posted: ${sent.url}` : ''}`
            );

            // Send early-loc notification if party/location were set during creation
            if (earlyLocNotification) {
                sendEarlyLocNotification(
                    interaction.client,
                    guild.id,
                    interaction.user.id,
                    d.codeName,
                    d.dungeonName,
                    raidChannel.id,
                    sent.id,
                    earlyLocNotification
                ).catch(err => {
                    logger.error({ err, guildId: guild.id, runId }, 
                        'Failed to send early-loc notification');
                });
            }

            // Automatically add the organizer to their run (simulates clicking join button)
            // This happens after the message is posted but before the organizer panel
            await autoJoinOrganizerToRun(
                interaction.client,
                guild,
                sent,
                runId,
                interaction.user.id,
                interaction.user.username,
                d.codeName,
                d.dungeonName,
                role?.id || null
            );

            // Show the organizer panel automatically as a followUp
            // This uses the shared helper which registers the panel for live updates
            await sendRunOrganizerPanelAsFollowUp(interaction, runId, guild.id);

            // Add reactions to the run message based on dungeon configuration
            // This happens AFTER the user gets their response, so it doesn't delay the feedback
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
