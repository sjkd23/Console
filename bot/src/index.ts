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
import { handleKeyWindow } from './interactions/buttons/raids/key-window.js';
import { handleRealmScore } from './interactions/buttons/raids/realm-score.js';
import { handleRealmClosed, handleMiniboss, handleThirdRoom } from './interactions/buttons/raids/o3-progression.js';
import { handleSetParty, handleSetLocation, handleSetChainAmount, handleSetPartyLocation } from './interactions/buttons/raids/party-location.js';
import { handleScreenshotButton } from './interactions/buttons/raids/screenshot-submit.js';
import { handleKeyReaction } from './interactions/buttons/raids/key-reaction.js';
import { handlePingRaiders } from './interactions/buttons/raids/ping-raiders.js';
import { handleLockJoin } from './interactions/buttons/raids/lock-join.js';
import { handleHeadcountJoin } from './interactions/buttons/raids/headcount-join.js';
import { handleHeadcountKey } from './interactions/buttons/raids/headcount-key.js';
import { handleHeadcountOrganizerPanel, handleHeadcountOrganizerPanelConfirm, handleHeadcountOrganizerPanelDeny } from './interactions/buttons/raids/headcount-organizer-panel.js';
import { handleHeadcountEnd } from './interactions/buttons/raids/headcount-end.js';
import { handleHeadcountConvert } from './interactions/buttons/raids/headcount-convert.js';
import { handlePartyClose } from './interactions/buttons/raids/party-actions.js';
import {
    handleQuotaConfigBasic,
    handleQuotaConfigModeration,
    handleQuotaConfigBasePoints,
    handleQuotaConfigDungeons,
    handleQuotaRefreshPanel,
    handleQuotaResetPanel,
    handleQuotaDeleteConfig,
    handleQuotaConfigStop,
    handleQuotaBasicModal,
    handleQuotaModerationModal,
    handleQuotaBasePointsModal,
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
    handleRolePingToggle,
    handleRolePingAddAll,
    handleRolePingRemoveAll,
} from './interactions/buttons/config/roleping-panel.js';
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
} from './commands/moderation/modmail.js';
import { handleModmailClose } from './interactions/buttons/modmail/modmail-close.js';
import { startScheduledTasks } from './lib/tasks/scheduled-tasks.js';
import { syncTeamRoleForMember } from './lib/team/team-role-manager.js';
import { logCommandExecution, createSuccessResult, createErrorResult } from './lib/logging/command-logging.js';
import { BackendError } from './lib/utilities/http.js';
import { applyButtonRateLimit } from './lib/utilities/rate-limit-middleware.js';
import { safeHandleInteraction } from './lib/utilities/safe-handle-interaction.js';
import { createLogger } from './lib/logging/logger.js';

const logger = createLogger('Bot');

// Global error handlers to prevent bot crashes from unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled promise rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
        promise: promise,
    });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', {
        error: error.message,
        stack: error.stack,
    });
    // For uncaught exceptions, we may want to exit gracefully
    // Uncomment the following lines if you want the bot to restart via Docker/PM2
    // process.exit(1);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers, // Required for guildMemberUpdate event
        GatewayIntentBits.GuildMessages, // Required for message collectors in guild channels
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
    // Autocomplete doesn't need the full wrapper (ultra-fast, no deferral)
    if (interaction.isAutocomplete()) {
        try {
            const cmd = commands.find(c => c.data.name === interaction.commandName);
            if (cmd?.autocomplete) await cmd.autocomplete(interaction);
            else await interaction.respond([]);
        } catch (error) {
            console.error('[Autocomplete] Error:', error);
        }
        return;
    }

    if (interaction.isChatInputCommand()) {
            const cmd = commands.find(c => c.data.name === interaction.commandName);
            if (cmd) {
                const startTime = Date.now();
                let commandSuccess = true;
                let errorCode: string | undefined;

                // Use safe handler wrapper for consistent error handling and deferral
                await safeHandleInteraction(
                    interaction,
                    async () => {
                        try {
                            await cmd.run(interaction);
                        } catch (err) {
                            commandSuccess = false;

                            // Categorize the error for logging
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

                            // Re-throw so safeHandleInteraction can handle it
                            throw err;
                        }
                    },
                    {
                        // Commands are public by default
                        ephemeral: false,
                    }
                );

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
            return;
        }

        if (interaction.isButton()) {
            // Handle party buttons
            if (interaction.customId.startsWith('party:close:')) {
                if (!await applyButtonRateLimit(interaction, 'party:close')) return;
                const creatorId = interaction.customId.split(':')[2];
                await safeHandleInteraction(interaction, () => handlePartyClose(interaction, creatorId), { ephemeral: true });
                return;
            }

            // Handle verification buttons (strict rate limiting)
            if (interaction.customId === 'verification:get_verified') {
                if (!await applyButtonRateLimit(interaction, 'verification:start')) return;
                await safeHandleInteraction(interaction, () => handleGetVerified(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId === 'verification:realmeye') {
                if (!await applyButtonRateLimit(interaction, 'verification:method')) return;
                await safeHandleInteraction(interaction, () => handleRealmEyeVerification(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId === 'verification:done' || interaction.customId.startsWith('verification:done:')) {
                if (!await applyButtonRateLimit(interaction, 'verification:submit')) return;
                await safeHandleInteraction(interaction, () => handleVerificationDone(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId === 'verification:cancel' || interaction.customId.startsWith('verification:cancel:')) {
                if (!await applyButtonRateLimit(interaction, 'verification:cancel')) return;
                await safeHandleInteraction(interaction, () => handleVerificationCancel(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId === 'verification:manual_screenshot' || interaction.customId.startsWith('verification:manual_screenshot:')) {
                if (!await applyButtonRateLimit(interaction, 'verification:method')) return;
                await safeHandleInteraction(interaction, () => handleManualVerifyScreenshot(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId === 'verification:realmeye' || interaction.customId.startsWith('verification:realmeye:')) {
                if (!await applyButtonRateLimit(interaction, 'verification:method')) return;
                await safeHandleInteraction(interaction, () => handleRealmEyeVerification(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('verification:approve:')) {
                if (!await applyButtonRateLimit(interaction, 'verification:approve')) return;
                await safeHandleInteraction(interaction, () => handleVerificationApprove(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('verification:deny:')) {
                if (!await applyButtonRateLimit(interaction, 'verification:deny')) return;
                await safeHandleInteraction(interaction, () => handleVerificationDeny(interaction), { ephemeral: true });
                return;
            }

            // Handle modmail buttons
            if (interaction.customId.startsWith('modmail:confirm:')) {
                if (!await applyButtonRateLimit(interaction, 'modmail:action')) return;
                await safeHandleInteraction(interaction, () => handleModmailConfirm(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('modmail:cancel:')) {
                if (!await applyButtonRateLimit(interaction, 'modmail:action')) return;
                await safeHandleInteraction(interaction, () => handleModmailCancel(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('modmail:close:')) {
                if (!await applyButtonRateLimit(interaction, 'modmail:action')) return;
                await safeHandleInteraction(interaction, () => handleModmailClose(interaction), { ephemeral: true });
                return;
            }

            // Handle role ping panel buttons
            if (interaction.customId.startsWith('roleping:toggle:')) {
                if (!await applyButtonRateLimit(interaction, 'roleping:toggle')) return;
                const dungeonKey = interaction.customId.split(':')[2];
                await safeHandleInteraction(interaction, () => handleRolePingToggle(interaction, dungeonKey), { ephemeral: true });
                return;
            }
            if (interaction.customId === 'roleping:addall') {
                if (!await applyButtonRateLimit(interaction, 'roleping:bulk')) return;
                await safeHandleInteraction(interaction, () => handleRolePingAddAll(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId === 'roleping:removeall') {
                if (!await applyButtonRateLimit(interaction, 'roleping:bulk')) return;
                await safeHandleInteraction(interaction, () => handleRolePingRemoveAll(interaction), { ephemeral: true });
                return;
            }

            // Handle quota config buttons (restrictive rate limiting)
            if (interaction.customId.startsWith('quota_config_basic:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await safeHandleInteraction(interaction, () => handleQuotaConfigBasic(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('quota_config_base_points:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await safeHandleInteraction(interaction, () => handleQuotaConfigBasePoints(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('quota_config_moderation:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await safeHandleInteraction(interaction, () => handleQuotaConfigModeration(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('quota_config_dungeons:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await safeHandleInteraction(interaction, () => handleQuotaConfigDungeons(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('quota_refresh_panel:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await safeHandleInteraction(interaction, () => handleQuotaRefreshPanel(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('quota_reset_panel:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await safeHandleInteraction(interaction, () => handleQuotaResetPanel(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('quota_delete_config:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await safeHandleInteraction(interaction, () => handleQuotaDeleteConfig(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('quota_config_stop:')) {
                if (!await applyButtonRateLimit(interaction, 'quota_config_panel')) return;
                await safeHandleInteraction(interaction, () => handleQuotaConfigStop(interaction), { ephemeral: true });
                return;
            }

            // Handle points config buttons
            if (interaction.customId === 'points_config_dungeons' || interaction.customId.startsWith('points_config_dungeons:')) {
                if (!await applyButtonRateLimit(interaction, 'points_config_panel')) return;
                await safeHandleInteraction(interaction, () => handlePointsConfigDungeons(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId === 'points_config_keys' || interaction.customId.startsWith('points_config_keys:')) {
                if (!await applyButtonRateLimit(interaction, 'points_config_panel')) return;
                await safeHandleInteraction(interaction, () => handlePointsConfigKeys(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId === 'points_config_stop' || interaction.customId.startsWith('points_config_stop:')) {
                if (!await applyButtonRateLimit(interaction, 'points_config_panel')) return;
                await safeHandleInteraction(interaction, () => handlePointsConfigStop(interaction), { ephemeral: true });
                return;
            }

            // Handle headcount buttons
            if (interaction.customId.startsWith('headcount:join:')) {
                if (!await applyButtonRateLimit(interaction, 'run:participation')) return;
                const panelTimestamp = interaction.customId.split(':')[2];
                await safeHandleInteraction(interaction, () => handleHeadcountJoin(interaction, panelTimestamp), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('headcount:key:')) {
                if (!await applyButtonRateLimit(interaction, 'run:key:headcount')) return;
                const parts = interaction.customId.split(':');
                const panelTimestamp = parts[2];
                const dungeonCode = parts[3];
                const mapKey = parts[4]; // Optional: specific key type (e.g., "WC_INC", "SHIELD_RUNE")
                await safeHandleInteraction(interaction, () => handleHeadcountKey(interaction, panelTimestamp, dungeonCode, mapKey), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('headcount:org:')) {
                if (!await applyButtonRateLimit(interaction, 'headcount:organizer')) return;
                const parts = interaction.customId.split(':');
                const action = parts[2]; // 'confirm', 'deny', or panelTimestamp
                const identifier = parts[3]; // publicMessageId if confirm/deny

                if (action === 'confirm' && identifier) {
                    await safeHandleInteraction(interaction, () => handleHeadcountOrganizerPanelConfirm(interaction, identifier), { ephemeral: true });
                    return;
                }
                if (action === 'deny' && identifier) {
                    await safeHandleInteraction(interaction, () => handleHeadcountOrganizerPanelDeny(interaction, identifier), { ephemeral: true });
                    return;
                }
                // Regular headcount organizer panel access
                const panelTimestamp = action; // The timestamp is in the action position
                await safeHandleInteraction(interaction, () => handleHeadcountOrganizerPanel(interaction, panelTimestamp), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('headcount:end:')) {
                if (!await applyButtonRateLimit(interaction, 'headcount:organizer')) return;
                const publicMessageId = interaction.customId.split(':')[2];
                await safeHandleInteraction(interaction, () => handleHeadcountEnd(interaction, publicMessageId), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('headcount:convert:')) {
                if (!await applyButtonRateLimit(interaction, 'headcount:organizer')) return;
                const publicMessageId = interaction.customId.split(':')[2];
                await safeHandleInteraction(interaction, () => handleHeadcountConvert(interaction, publicMessageId), { ephemeral: true });
                return;
            }

            // Handle run management buttons
            const [ns, action, runId, ...rest] = interaction.customId.split(':');
            
            // Handle key logging buttons (after run ends)
            if (ns === 'keylog') {
                if (action === 'custom') {
                    const { handleKeyLogCustomName } = await import('./interactions/buttons/raids/key-logging.js');
                    // Don't wrap in safeHandleInteraction - modals must be shown immediately
                    try {
                        await handleKeyLogCustomName(interaction as ButtonInteraction, runId);
                    } catch (error) {
                        console.error('[KeyLog] Error showing custom name modal:', error);
                        // Try to send an error message if possible
                        try {
                            if (!interaction.replied && !interaction.deferred) {
                                await interaction.reply({ content: 'Failed to show modal. Please try again.', flags: MessageFlags.Ephemeral });
                            }
                        } catch {
                            // Silently fail if we can't even send an error message
                        }
                    }
                    return;
                }
                if (action === 'cancel') {
                    const { handleKeyLogCancel } = await import('./interactions/buttons/raids/key-logging.js');
                    await safeHandleInteraction(interaction, () => handleKeyLogCancel(interaction as ButtonInteraction, runId), { ephemeral: true });
                    return;
                }
                if (action === 'close') {
                    const { handleKeyLogClose } = await import('./interactions/buttons/raids/key-logging.js');
                    await safeHandleInteraction(interaction, () => handleKeyLogClose(interaction as ButtonInteraction, runId), { ephemeral: true });
                    return;
                }
                if (action === 'back') {
                    const { handleKeyLogBack } = await import('./interactions/buttons/raids/key-logging.js');
                    await safeHandleInteraction(interaction, () => handleKeyLogBack(interaction as ButtonInteraction, runId), { ephemeral: true });
                    return;
                }
                if (action === 'selectuser' && rest.length > 0) {
                    // This is from the "Continue" button after custom name search
                    const userId = rest[0];
                    const { handleKeyLogSelectUserFromButton } = await import('./interactions/buttons/raids/key-logging.js');
                    await safeHandleInteraction(interaction, () => handleKeyLogSelectUserFromButton(interaction as ButtonInteraction, runId, userId), { ephemeral: true });
                    return;
                }
            }

            if (ns !== 'run' || !runId) return;

            if (action === 'org' || action === 'panel') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                // Check if this is a confirmation action
                if (runId === 'confirm' && rest.length > 0) {
                    await safeHandleInteraction(interaction, () => handleOrganizerPanelConfirm(interaction, rest.join(':')), { ephemeral: true });
                    return;
                }
                if (runId === 'deny' && rest.length > 0) {
                    await safeHandleInteraction(interaction, () => handleOrganizerPanelDeny(interaction, rest.join(':')), { ephemeral: true });
                    return;
                }
                // Regular organizer panel access
                await safeHandleInteraction(interaction, () => handleOrganizerPanel(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'join') {
                if (!await applyButtonRateLimit(interaction, 'run:participation')) return;
                await safeHandleInteraction(interaction, () => handleJoin(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'leave') {
                if (!await applyButtonRateLimit(interaction, 'run:participation')) return;
                await safeHandleInteraction(interaction, () => handleLeave(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'key') {
                if (!await applyButtonRateLimit(interaction, 'run:key:reaction')) return;
                // Key reaction: run:key:runId:keyType
                const keyType = rest.join(':'); // In case keyType contains colons
                await safeHandleInteraction(interaction, () => handleKeyReaction(interaction, runId, keyType), { ephemeral: true });
                return;
            }
            if (action === 'start') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await safeHandleInteraction(interaction, () => handleStatus(interaction, runId, 'live'), { ephemeral: true });
                return;
            }
            if (action === 'end') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await safeHandleInteraction(interaction, () => handleStatus(interaction, runId, 'ended'), { ephemeral: true });
                return;
            }
            if (action === 'cancel') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await safeHandleInteraction(interaction, () => handleStatus(interaction, runId, 'cancelled'), { ephemeral: true });
                return;
            }
            if (action === 'keypop') {
                if (!await applyButtonRateLimit(interaction, 'run:keypop')) return;
                await safeHandleInteraction(interaction, () => handleKeyWindow(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'realmscore') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await safeHandleInteraction(interaction, () => handleRealmScore(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'realmclosed') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await safeHandleInteraction(interaction, () => handleRealmClosed(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'miniboss') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await safeHandleInteraction(interaction, () => handleMiniboss(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'thirdroom') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await safeHandleInteraction(interaction, () => handleThirdRoom(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'setpartyloc') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await safeHandleInteraction(interaction, () => handleSetPartyLocation(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'setparty') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await safeHandleInteraction(interaction, () => handleSetParty(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'setlocation') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await safeHandleInteraction(interaction, () => handleSetLocation(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'screenshot') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await safeHandleInteraction(interaction, () => handleScreenshotButton(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'setchain') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await safeHandleInteraction(interaction, () => handleSetChainAmount(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'ping') {
                if (!await applyButtonRateLimit(interaction, 'run:ping')) return;
                await safeHandleInteraction(interaction, () => handlePingRaiders(interaction, runId), { ephemeral: true });
                return;
            }
            if (action === 'lockjoin') {
                if (!await applyButtonRateLimit(interaction, 'run:organizer')) return;
                await safeHandleInteraction(interaction, () => handleLockJoin(interaction, runId), { ephemeral: true });
                return;
            }

            // fallback
            await interaction.reply({ content: 'Unknown action.', flags: MessageFlags.Ephemeral });
        }

        // Handle modal submissions
        if (interaction.isModalSubmit()) {
            // Handle key logging custom name modal
            if (interaction.customId.startsWith('keylog:customname:modal:')) {
                const runId = interaction.customId.split(':')[3];
                const { handleKeyLogCustomNameModal } = await import('./interactions/buttons/raids/key-logging.js');
                await safeHandleInteraction(interaction, () => handleKeyLogCustomNameModal(interaction, runId), { ephemeral: true });
                return;
            }

            if (interaction.customId.startsWith('verification:approve_modal:') || interaction.customId.startsWith('verification:approve_confirm:')) {
                await safeHandleInteraction(interaction, () => handleVerificationApproveModal(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('quota_basic_modal:')) {
                await safeHandleInteraction(interaction, () => handleQuotaBasicModal(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('quota_base_points_modal:')) {
                await safeHandleInteraction(interaction, () => handleQuotaBasePointsModal(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('quota_moderation_modal:')) {
                await safeHandleInteraction(interaction, () => handleQuotaModerationModal(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('quota_dungeon_modal:')) {
                await safeHandleInteraction(interaction, () => handleQuotaDungeonModal(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('points_dungeon_modal:')) {
                await safeHandleInteraction(interaction, () => handlePointsDungeonModal(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('key_pop_points_dungeon_modal:')) {
                await safeHandleInteraction(interaction, () => handleKeyPopPointsDungeonModal(interaction), { ephemeral: true });
                return;
            }
        }

        // Handle select menu interactions
        if (interaction.isStringSelectMenu()) {
            // Handle O3 miniboss selection
            if (interaction.customId.startsWith('run:miniboss_select:')) {
                const runId = interaction.customId.split(':')[2];
                const { handleMinibossSelect } = await import('./interactions/buttons/raids/o3-progression.js');
                await safeHandleInteraction(interaction, () => handleMinibossSelect(interaction, runId), { ephemeral: true });
                return;
            }

            // Handle key logging select menus
            if (interaction.customId.startsWith('keylog:selectuser:')) {
                const runId = interaction.customId.split(':')[2];
                const { handleKeyLogSelectUser } = await import('./interactions/buttons/raids/key-logging.js');
                await safeHandleInteraction(interaction, () => handleKeyLogSelectUser(interaction, runId), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('keylog:keycount:')) {
                const parts = interaction.customId.split(':');
                const runId = parts[2];
                const userId = parts[3];
                const { handleKeyLogKeyCount } = await import('./interactions/buttons/raids/key-logging.js');
                await safeHandleInteraction(interaction, () => handleKeyLogKeyCount(interaction, runId, userId), { ephemeral: true });
                return;
            }

            // Handle modmail select menu
            if (interaction.customId.startsWith('modmail:select_guild:')) {
                // This is handled in the modmail command's collector
                return;
            }

            if (interaction.customId.startsWith('quota_select_dungeon_exalt:') ||
                interaction.customId.startsWith('quota_select_dungeon_misc1:') ||
                interaction.customId.startsWith('quota_select_dungeon_misc2:')) {
                await safeHandleInteraction(interaction, () => handleQuotaSelectDungeon(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('points_select_dungeon_exalt') ||
                interaction.customId.startsWith('points_select_dungeon_misc1') ||
                interaction.customId.startsWith('points_select_dungeon_misc2')) {
                await safeHandleInteraction(interaction, () => handlePointsSelectDungeon(interaction), { ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith('key_pop_points_select_dungeon_exalt') ||
                interaction.customId.startsWith('key_pop_points_select_dungeon_misc1') ||
                interaction.customId.startsWith('key_pop_points_select_dungeon_misc2')) {
                await safeHandleInteraction(interaction, () => handleKeyPopPointsSelectDungeon(interaction), { ephemeral: true });
                return;
            }
        }
});


await client.login(botConfig.SECRET_KEY);
