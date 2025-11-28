/**
 * Tracks active headcount organizer panels for auto-refresh when keys are reacted.
 * 
 * REFACTORED: Now stores HeadcountOrganizerPanelHandle objects that know how to edit themselves.
 * This allows ephemeral follow-ups (from auto-popup) and ephemeral replies (from buttons)
 * to be edited correctly, fixing the Discord API "Unknown Message" error.
 */

import { ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction, Message, InteractionWebhook } from 'discord.js';

/**
 * Handle type for headcount organizer panels, abstracting over different edit methods.
 * 
 * - `interactionReply`: Panel created via interaction.reply() - edit via interaction.editReply()
 * - `followup`: Panel created via interaction.followUp() - edit via webhook.editMessage(messageId)
 * - `publicMessage`: Panel in a regular channel - edit via message.edit()
 */
export type HeadcountOrganizerPanelHandle =
    | {
        type: 'interactionReply';
        interaction: ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction;
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
 * Map of headcount message ID to array of active organizer panel handles.
 * When a key is reacted on a headcount, all tracked panels for that message ID are refreshed.
 */
const activeHeadcountPanels = new Map<string, Array<HeadcountOrganizerPanelHandle>>();

/**
 * Register a headcount organizer panel for auto-refresh.
 * When keys are reacted on this headcount, this panel will be updated.
 * 
 * @param publicMessageId The ID of the public headcount message
 * @param handle The panel handle that knows how to edit itself
 */
export function registerHeadcountPanel(
    publicMessageId: string, 
    handle: HeadcountOrganizerPanelHandle
): void {
    const existing = activeHeadcountPanels.get(publicMessageId) || [];
    existing.push(handle);
    activeHeadcountPanels.set(publicMessageId, existing);
}

/**
 * Get all active organizer panel handles for a headcount message.
 * @param publicMessageId The ID of the public headcount message
 * @returns Array of handles that know how to edit themselves
 */
export function getActiveHeadcountPanels(publicMessageId: string): Array<HeadcountOrganizerPanelHandle> {
    return activeHeadcountPanels.get(publicMessageId) || [];
}

/**
 * Remove all tracked organizer panels for a headcount (e.g., when converted to run or ended).
 * @param publicMessageId The ID of the public headcount message
 */
export function clearHeadcountPanels(publicMessageId: string): void {
    activeHeadcountPanels.delete(publicMessageId);
}

/**
 * Remove a specific panel handle (e.g., if it becomes invalid).
 * @param publicMessageId The ID of the public headcount message
 * @param handle The handle to remove
 */
export function unregisterHeadcountPanel(
    publicMessageId: string, 
    handle: HeadcountOrganizerPanelHandle
): void {
    const existing = activeHeadcountPanels.get(publicMessageId);
    if (!existing) return;
    
    // Filter by comparing the handle objects (reference equality should work for most cases)
    const filtered = existing.filter(h => h !== handle);
    if (filtered.length === 0) {
        activeHeadcountPanels.delete(publicMessageId);
    } else {
        activeHeadcountPanels.set(publicMessageId, filtered);
    }
}
