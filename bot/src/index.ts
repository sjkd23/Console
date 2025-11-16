// src/index.ts
import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(process.cwd(), '.env') });

import { botConfig } from './config.js';
import {
    Client,
    Events,
    GatewayIntentBits,
    MessageFlags,
    Partials,
    Interaction,
    ButtonInteraction
} from 'discord.js';
import { commands } from './commands/index.js';
import { handleOrganizerPanel, handleOrganizerPanelConfirm, handleOrganizerPanelDeny } from './interactions/buttons/raids/organizer-panel.js';
import { handleJoin } from './interactions/buttons/raids/join.js';
import { handleLeave } from './interactions/buttons/raids/leave.js';
import { handleStatus } from './interactions/buttons/raids/run-status.js';
import { handleClassSelection } from './interactions/buttons/raids/class-selection.js';
import { handleKeyWindow } from './interactions/buttons/raids/key-window.js';
import { handleSetParty, handleSetLocation, handleSetChainAmount } from './interactions/buttons/raids/party-location.js';
import { handleKeyReaction } from './interactions/buttons/raids/key-reaction.js';
import { handlePingRaiders } from './interactions/buttons/raids/ping-raiders.js';
import { handleHeadcountJoin } from './interactions/buttons/raids/headcount-join.js';
import { handleHeadcountKey } from './interactions/buttons/raids/headcount-key.js';
import { handleHeadcountOrganizerPanel, handleHeadcountOrganizerPanelConfirm, handleHeadcountOrganizerPanelDeny } from './interactions/buttons/raids/headcount-organizer-panel.js';
import { handleHeadcountEnd } from './interactions/buttons/raids/headcount-end.js';
import { handleHeadcountConvert } from './interactions/buttons/raids/headcount-convert.js';
import {
    handleQuotaConfigBasic,
    handleQuotaConfigModeration,
    handleQuotaConfigDungeons,
    handleQuotaRefreshPanel,
    handleQuotaResetPanel,
    handleQuotaConfigStop,
    handleQuotaBasicModal,
    handleQuotaModerationModal,
    handleQuotaDungeonModal,
    handleQuotaSelectDungeon,
} from './interactions/buttons/config/quota-config.js';
import {
    handlePointsConfigDungeons,
    handlePointsConfigStop,
    handlePointsSelectDungeon,
    handlePointsDungeonModal,
} from './interactions/buttons/config/points-config.js';
import {
    handlePointsConfigKeys,
    handleKeyPopPointsSelectDungeon,
    handleKeyPopPointsDungeonModal,
} from './interactions/buttons/config/key-pop-points-config.js';
import {
    handleGetVerified,
    handleRealmEyeVerification,
    handleVerificationDone,
    handleVerificationCancel,
    handleManualVerifyScreenshot,
} from './interactions/buttons/verification/get-verified.js';
import {
    handleVerificationApprove,
    handleVerificationDeny,
    handleVerificationApproveModal,
} from './interactions/buttons/verification/approve-deny.js';
import {
    handleModmailConfirm,
    handleModmailCancel,
} from './commands/moderation/security/modmail.js';
import { handleModmailClose } from './interactions/buttons/modmail/modmail-close.js';
import { startScheduledTasks } from './lib/tasks/scheduled-tasks.js';
import { syncTeamRoleForMember } from './lib/team/team-role-manager.js';
import { logCommandExecution, createSuccessResult, createErrorResult } from './lib/logging/command-logging.js';
import { BackendError } from './lib/utilities/http.js';
import { applyButtonRateLimit } from './lib/utilities/rate-limit-middleware.js';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers, // Required for guildMemberUpdate event
        GatewayIntentBits.GuildEmojisAndStickers, // Required for emoji cache
        GatewayIntentBits.DirectMessages, // Required for DM-based verification
        GatewayIntentBits.MessageContent, // Required to read message content in DMs
    ],
    partials: [Partials.Channel, Partials.GuildMember, Partials.User]
});

client.once(Events.ClientReady, () => {
    console.log(`Logged in as ${client.user?.tag}`);

    // Start all scheduled maintenance tasks (runs, suspensions, verification cleanup, etc.)
    startScheduledTasks(client);
});

// Listen for role changes on guild members
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    try {
        // Check if roles changed
        const oldRoles = oldMember.roles.cache;
        const newRoles = newMember.roles.cache;

        // If roles are different, sync team role
        if (oldRoles.size !== newRoles.size ||
            !oldRoles.every(role => newRoles.has(role.id))) {
            await syncTeamRoleForMember(newMember);
        }
    } catch (error) {
        console.error('[GuildMemberUpdate] Error syncing team role:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isAutocomplete()) {
            const cmd = commands.find(c => c.data.name === interaction.commandName);
            if (cmd?.autocomplete) await cmd.autocomplete(interaction);
            else await interaction.respond([]);
            return;
        }

        if (interaction.isChatInputCommand()) {
            const cmd = commands.find(c => c.data.name === interaction.commandName);
            if (cmd) {
                const startTime = Date.now();
                let commandSuccess = true;
                let errorCode: string | undefined;

                try {
                    await cmd.run(interaction);
                } catch (err) {
                    commandSuccess = false;

                    // Categorize the error
                    if (err instanceof BackendError) {
                        errorCode = err.code || 'BACKEND_ERROR';
                    } else if (err instanceof Error) {
                        // Try to infer error type from message
                        const msg = err.message.toLowerCase();
                        if (msg.includes('permission')) {
                            errorCode = 'MISSING_PERMISSIONS';
                        } else if (msg.includes('timeout')) {
                            errorCode = 'TIMEOUT';
                        } else {
                            errorCode = 'UNKNOWN_ERROR';
                        }
                    } else {
                        errorCode = 'UNKNOWN_ERROR';
                    }

                    // Re-throw to preserve existing error handling
                    throw err;
                } finally {
                    // Log command execution (success or failure)
                    const latencyMs = Date.now() - startTime;
                    const result = commandSuccess
                        ? createSuccessResult(latencyMs)
                        : createErrorResult(errorCode!, latencyMs);

                    // Non-blocking log - won't affect command execution
                    logCommandExecution(interaction, result).catch(logErr => {
                        console.warn('[CommandLogging] Failed to log command:', logErr);
                    });
                }
            }
            return;
        }

        if (interaction.isButton()) {
            // Handle verification buttons (strict rate limiting)
            if (interaction.customId === 'verification:get_verified') {
                if (!await applyButtonRateLimit(interaction, 'verification:start')) return;
                await handleGetVerified(interaction);
                return;
            }
            if (interaction.customId === 'verification:realmeye') {
                if (!await applyButtonRateLimit(interaction, 'verification:method')) return;
                await handleRealmEyeVerification(interaction);
                return;
            }
            if (interaction.customId === 'verification:done') {
                if (!await applyButtonRateLimit(interaction, 'verification:submit')) return;
                await handleVerificationDone(interaction);
                return;
            }
            if (interaction.customId === 'verification:cancel') {
                if (!await applyButtonRateLimit(interaction, 'verification:cancel')) return;
                await handleVerificationCancel(interaction);
                return;
            }
            if (interaction.customId === 'verification:manual_screenshot') {
                if (!await applyButtonRateLimit(interaction, 'verification:method')) return;
                await handleManualVerifyScreenshot(interaction);
                return;
            }
            if (interaction.customId.startsWith('verification:approve:')) {
                if (!await applyButtonRateLimit(interaction, 'verification:approve')) return;
                await handleVerificationApprove(interaction);
                return;
            }
            if (interaction.customId.startsWith('verification:deny:')) {
                if (!await applyButtonRateLimit(interaction, 'verification:deny')) return;
                await handleVerificationDeny(interaction);
                return;
            }

            // Handle modmail buttons
            if (interaction.customId.startsWith('modmail:confirm:')) {
                if (!await applyButtonRateLimit(interaction, 'modmail:action')) return;
                await handleModmailConfirm(interaction);
                return;
            }
            if (interaction.customId.startsWith('modmail:cancel:')) {
                if (!await applyButtonRateLimit(interaction, 'modmail:action')) return;
                await handleModmailCancel(interaction);
                return;
            }
            if (interaction.customId.startsWith('modmail:close:')) {
                if (!await applyButtonRateLimit(interaction, 'modmail:action')) return;
                await handleModmailClose(interaction);
                return;
            }

            // Handle quota config buttons (restrictive rate limiting)
            if (interaction.customId.startsWith('quota_config_basic:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await handleQuotaConfigBasic(interaction);
                return;
            }
            if (interaction.customId.startsWith('quota_config_moderation:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await handleQuotaConfigModeration(interaction);
                return;
            }
            if (interaction.customId.startsWith('quota_config_dungeons:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await handleQuotaConfigDungeons(interaction);
                return;
            }
            if (interaction.customId.startsWith('quota_refresh_panel:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await handleQuotaRefreshPanel(interaction);
                return;
            }
            if (interaction.customId.startsWith('quota_reset_panel:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await handleQuotaResetPanel(interaction);
                return;
            }
            if (interaction.customId.startsWith('quota_config_stop:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await handleQuotaConfigStop(interaction);
                return;
            }

            // Handle points config buttons
            if (interaction.customId === 'points_config_dungeons' || interaction.customId.startsWith('points_config_dungeons:')) {
                if (!await applyButtonRateLimit(interaction, 'points_config_panel')) return;
                await handlePointsConfigDungeons(interaction);
                return;
            }
            if (interaction.customId === 'points_config_keys' || interaction.customId.startsWith('points_config_keys:')) {
                if (!await applyButtonRateLimit(interaction, 'points_config_panel')) return;
                await handlePointsConfigKeys(interaction);
                return;
            }
            if (interaction.customId === 'points_config_stop' || interaction.customId.startsWith('points_config_stop:')) {
                if (!await applyButtonRateLimit(interaction, 'points_config_panel')) return;
                await handlePointsConfigStop(interaction);
                return;
            }

            // Handle headcount buttons
            if (interaction.customId.startsWith('headcount:join:')) {
                if (!await applyButtonRateLimit(interaction, 'run:participation')) return;
                const panelTimestamp = interaction.customId.split(':')[2];
                await handleHeadcountJoin(interaction, panelTimestamp);
                return;
            }
            if (interaction.customId.startsWith('headcount:key:')) {
                if (!await applyButtonRateLimit(interaction, 'run:key:headcount')) return;
                const [, , panelTimestamp, dungeonCode] = interaction.customId.split(':');
                await handleHeadcountKey(interaction, panelTimestamp, dungeonCode);
                return;
            }
            if (interaction.customId.startsWith('headcount:org:')) {
                if (!await applyButtonRateLimit(interaction, 'headcount:organizer')) return;
                const parts = interaction.customId.split(':');
                const action = parts[2]; // 'confirm', 'deny', or panelTimestamp
                const identifier = parts[3]; // publicMessageId if confirm/deny

                if (action === 'confirm' && identifier) {
                    await handleHeadcountOrganizerPanelConfirm(interaction, identifier);
                    return;
                }
                if (action === 'deny' && identifier) {
                    await handleHeadcountOrganizerPanelDeny(interaction, identifier);
                    return;
                }
                // Regular headcount organizer panel access
                const panelTimestamp = action; // The timestamp is in the action position
                await handleHeadcountOrganizerPanel(interaction, panelTimestamp);
                return;
            }
            if (interaction.customId.startsWith('headcount:end:')) {
                if (!await applyButtonRateLimit(interaction, 'headcount:organizer')) return;
                const publicMessageId = interaction.customId.split(':')[2];
                await handleHeadcountEnd(interaction, publicMessageId);
                return;
            }
            if (interaction.customId.startsWith('headcount:convert:')) {
                if (!await applyButtonRateLimit(interaction, 'headcount:organizer')) return;
                const publicMessageId = interaction.customId.split(':')[2];
                await handleHeadcountConvert(interaction, publicMessageId);
                return;
            }

            // Handle run management buttons
            const [ns, action, runId, ...rest] = interaction.customId.split(':');
            if (ns !== 'run' || !runId) return;

            if (action === 'org' || action === 'panel') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                // Check if this is a confirmation action
                if (runId === 'confirm' && rest.length > 0) {
                    await handleOrganizerPanelConfirm(interaction, rest.join(':'));
                    return;
                }
                if (runId === 'deny' && rest.length > 0) {
                    await handleOrganizerPanelDeny(interaction, rest.join(':'));
                    return;
                }
                // Regular organizer panel access
                await handleOrganizerPanel(interaction, runId);
                return;
            }
            if (action === 'join') {
                if (!await applyButtonRateLimit(interaction, 'run:participation')) return;
                await handleJoin(interaction, runId);
                return;
            }
            if (action === 'leave') {
                if (!await applyButtonRateLimit(interaction, 'run:participation')) return;
                await handleLeave(interaction, runId);
                return;
            }
            if (action === 'class') {
                if (!await applyButtonRateLimit(interaction, 'run:class_selection')) return;
                await handleClassSelection(interaction, runId);
                return;
            }
            if (action === 'key') {
                if (!await applyButtonRateLimit(interaction, 'run:key:reaction')) return;
                // Key reaction: run:key:runId:keyType
                const keyType = rest.join(':'); // In case keyType contains colons
                await handleKeyReaction(interaction, runId, keyType);
                return;
            }
            if (action === 'start') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await handleStatus(interaction, runId, 'live');
                return;
            }
            if (action === 'end') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await handleStatus(interaction, runId, 'ended');
                return;
            }
            if (action === 'cancel') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await handleStatus(interaction, runId, 'cancelled');
                return;
            }
            if (action === 'keypop') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await handleKeyWindow(interaction, runId);
                return;
            }
            if (action === 'setparty') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await handleSetParty(interaction, runId);
                return;
            }
            if (action === 'setlocation') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await handleSetLocation(interaction, runId);
                return;
            }
            if (action === 'setchain') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await handleSetChainAmount(interaction, runId);
                return;
            }
            if (action === 'ping') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await handlePingRaiders(interaction, runId);
                return;
            }

            // fallback
            await interaction.reply({ content: 'Unknown action.', flags: MessageFlags.Ephemeral });
        }

        // Handle modal submissions
        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith('verification:approve_modal:')) {
                await handleVerificationApproveModal(interaction);
                return;
            }
            if (interaction.customId.startsWith('quota_basic_modal:')) {
                await handleQuotaBasicModal(interaction);
                return;
            }
            if (interaction.customId.startsWith('quota_moderation_modal:')) {
                await handleQuotaModerationModal(interaction);
                return;
            }
            if (interaction.customId.startsWith('quota_dungeon_modal:')) {
                await handleQuotaDungeonModal(interaction);
                return;
            }
            if (interaction.customId.startsWith('points_dungeon_modal:')) {
                await handlePointsDungeonModal(interaction);
                return;
            }
            if (interaction.customId.startsWith('key_pop_points_dungeon_modal:')) {
                await handleKeyPopPointsDungeonModal(interaction);
                return;
            }
        }

        // Handle select menu interactions
        if (interaction.isStringSelectMenu()) {
            // Handle modmail select menu
            if (interaction.customId.startsWith('modmail:select_guild:')) {
                // This is handled in the modmail command's collector
                return;
            }

            if (interaction.customId.startsWith('quota_select_dungeon_exalt:') ||
                interaction.customId.startsWith('quota_select_dungeon_misc1:') ||
                interaction.customId.startsWith('quota_select_dungeon_misc2:')) {
                await handleQuotaSelectDungeon(interaction);
                return;
            }
            if (interaction.customId.startsWith('points_select_dungeon_exalt') ||
                interaction.customId.startsWith('points_select_dungeon_misc1') ||
                interaction.customId.startsWith('points_select_dungeon_misc2')) {
                await handlePointsSelectDungeon(interaction);
                return;
            }
            if (interaction.customId.startsWith('key_pop_points_select_dungeon_exalt') ||
                interaction.customId.startsWith('key_pop_points_select_dungeon_misc1') ||
                interaction.customId.startsWith('key_pop_points_select_dungeon_misc2')) {
                await handleKeyPopPointsSelectDungeon(interaction);
                return;
            }
        }
    } catch (e) {
        console.error(e);
        if ('isRepliable' in interaction && interaction.isRepliable()) {
            interaction.deferred || interaction.replied
                ? await interaction.followUp({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral })
                : await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
        }
    }
});


await client.login(botConfig.SECRET_KEY);
