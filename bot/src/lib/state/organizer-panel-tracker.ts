import { ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction, Message, InteractionWebhook } from 'discord.js';

/**
 * Handle type for run organizer panels, abstracting over different edit methods.
 * 
 * - `interactionReply`: Panel created via interaction.reply() - edit via interaction.editReply()
 * - `followup`: Panel created via interaction.followUp() - edit via webhook.editMessage(messageId)
 * - `publicMessage`: Panel in a regular channel - edit via message.edit()
 */
export type RunOrganizerPanelHandle =
    | {
        type: 'interactionReply';
        interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction;
    }
    | {
        type: 'followup';
        webhook: InteractionWebhook;
        messageId: string;
    }
    | {
        type: 'publicMessage';
        message: Message<true>;
    };

/**
 * Track active organizer panels (ephemeral messages) so they can be refreshed on key reactions.
 * 
 * REFACTORED: Now stores RunOrganizerPanelHandle objects that know how to edit themselves.
 * This allows ephemeral follow-ups (from auto-popup) and ephemeral replies (from buttons)
 * to be edited correctly, fixing the Discord API "Unknown Message" error.
 * 
 * Key: `${runId}:${userId}` (runId and organizer's user ID)
 * Value: handle that knows how to edit the panel (interaction.editReply, webhook.editMessage, or message.edit)
 */
const activeOrganizerPanels = new Map<string, RunOrganizerPanelHandle>();

/**
 * Register an active organizer panel for auto-refresh on key reactions.
 * 
 * @param runId The run ID
 * @param userId The organizer's user ID
 * @param handle The panel handle that knows how to edit itself
 */
export function registerOrganizerPanel(
    runId: string,
    userId: string,
    handle: RunOrganizerPanelHandle
): void {
    const key = `${runId}:${userId}`;
    activeOrganizerPanels.set(key, handle);
}

/**
 * Unregister an organizer panel (when it's closed or run ends)
 */
export function unregisterOrganizerPanel(
    runId: string,
    userId: string
): void {
    const key = `${runId}:${userId}`;
    activeOrganizerPanels.delete(key);
}

/**
 * Get the active organizer panel handle for a run and user
 */
export function getOrganizerPanel(
    runId: string,
    userId: string
): RunOrganizerPanelHandle | undefined {
    const key = `${runId}:${userId}`;
    return activeOrganizerPanels.get(key);
}

/**
 * Get all active organizer panel handles for a specific run (multiple organizers might have it open).
 * Returns the handles that know how to edit themselves.
 */
export function getAllOrganizerPanelsForRun(runId: string): Array<{ userId: string; handle: RunOrganizerPanelHandle }> {
    const panels: Array<{ userId: string; handle: RunOrganizerPanelHandle }> = [];
    
    for (const [key, handle] of activeOrganizerPanels.entries()) {
        const [storedRunId, userId] = key.split(':');
        if (storedRunId === runId) {
            panels.push({ userId, handle });
        }
    }
    
    return panels;
}

/**
 * Clear all panels for a run (when run ends)
 */
export function clearOrganizerPanelsForRun(runId: string): void {
    const keysToDelete: string[] = [];
    
    for (const key of activeOrganizerPanels.keys()) {
        const [storedRunId] = key.split(':');
        if (storedRunId === runId) {
            keysToDelete.push(key);
        }
    }
    
    for (const key of keysToDelete) {
        activeOrganizerPanels.delete(key);
    }
}
