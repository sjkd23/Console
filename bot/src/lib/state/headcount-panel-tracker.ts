/**
 * Tracks active headcount organizer panels for auto-refresh when keys are reacted.
 * Similar to organizer-panel-tracker.ts but for headcount phase.
 */

import { ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction } from 'discord.js';

/**
 * Map of headcount message ID to array of active organizer panel interactions.
 * When a key is reacted on a headcount, all tracked panels for that message ID are refreshed.
 */
const activeHeadcountPanels = new Map<string, Array<ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction>>();

/**
 * Register a headcount organizer panel for auto-refresh.
 * When keys are reacted on this headcount, this panel will be updated.
 * @param publicMessageId The ID of the public headcount message
 * @param interaction The ephemeral organizer panel interaction (can be Button, ChatInput, or Modal)
 */
export function registerHeadcountPanel(
    publicMessageId: string, 
    interaction: ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction
): void {
    const existing = activeHeadcountPanels.get(publicMessageId) || [];
    existing.push(interaction);
    activeHeadcountPanels.set(publicMessageId, existing);
}

/**
 * Get all active organizer panels for a headcount message.
 * @param publicMessageId The ID of the public headcount message
 * @returns Array of interactions to refresh
 */
export function getActiveHeadcountPanels(publicMessageId: string): Array<ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction> {
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
 * Remove a specific panel interaction (e.g., if it becomes invalid).
 * @param publicMessageId The ID of the public headcount message
 * @param interaction The interaction to remove
 */
export function unregisterHeadcountPanel(
    publicMessageId: string, 
    interaction: ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction
): void {
    const existing = activeHeadcountPanels.get(publicMessageId);
    if (!existing) return;
    
    const filtered = existing.filter(i => i.id !== interaction.id);
    if (filtered.length === 0) {
        activeHeadcountPanels.delete(publicMessageId);
    } else {
        activeHeadcountPanels.set(publicMessageId, filtered);
    }
}
