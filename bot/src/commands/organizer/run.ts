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
            const { runId } = await postJSON<{ runId: number }>('/runs', {
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

            // Build the public embed (Starting/Lobby phase)
            const embed = new EmbedBuilder()
                .setTitle(`⏳ Starting Soon: ${d.dungeonName}`)
                .setDescription(`Organizer: <@${interaction.user.id}>`)
                // Raiders count hidden from public panel - shown in organizer panel only
                // .addFields(
                //     { name: 'Raiders', value: '0', inline: false }
                // )
                .setTimestamp(new Date());

            // Add Keys field if the dungeon has key reactions
            if (d.keyReactions && d.keyReactions.length > 0) {
                embed.addFields({ name: 'Keys', value: 'None', inline: false });
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

            // Reply immediately with the run link (before reactions are added)
            await interaction.editReply(
                `Run created${sent ? ` and posted: ${sent.url}` : ''}`
            );

            // Show the organizer panel automatically as a followUp
            try {
                const panelEmbed = new EmbedBuilder()
                    .setTitle(`Organizer Panel — ${d.dungeonName}`)
                    .setDescription(`**Raiders Joined:** 0\n\nManage the run with the controls below.`)
                    .setTimestamp(new Date());

                // Starting phase controls
                // Row 1: Start, Cancel
                const orgRow1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`run:start:${runId}`)
                        .setLabel('Start')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`run:cancel:${runId}`)
                        .setLabel('Cancel')
                        .setStyle(ButtonStyle.Danger)
                );

                // Row 2: Set Party/Loc + Chain Amount (if not Oryx 3)
                const orgRow2Components = [
                    new ButtonBuilder()
                        .setCustomId(`run:setpartyloc:${runId}`)
                        .setLabel('Set Party/Loc')
                        .setStyle(ButtonStyle.Secondary)
                ];

                if (d.codeName !== 'ORYX_3') {
                    orgRow2Components.push(
                        new ButtonBuilder()
                            .setCustomId(`run:setchain:${runId}`)
                            .setLabel('Chain Amount')
                            .setStyle(ButtonStyle.Secondary)
                    );
                }

                const orgRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(...orgRow2Components);

                const controls = [orgRow1, orgRow2];

                // Row 3: Screenshot button for Oryx 3
                if (d.codeName === 'ORYX_3') {
                    const screenshotRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`run:screenshot:${runId}`)
                            .setLabel('📸 Submit Screenshot')
                            .setStyle(ButtonStyle.Secondary)
                    );
                    controls.push(screenshotRow);
                }

                await interaction.followUp({
                    embeds: [panelEmbed],
                    components: controls,
                    flags: MessageFlags.Ephemeral
                });
            } catch (err) {
                logger.error('Failed to show organizer panel after run creation', {
                    guildId: guild.id,
                    runId: runId,
                    error: err instanceof Error ? err.message : String(err)
                });
                // Don't fail the run creation if panel fails - organizer can open it manually
            }

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
