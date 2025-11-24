import { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';

/**
 * Track active organizer panels (ephemeral messages) so they can be refreshed on key reactions
 * Key: `${runId}:${userId}` (runId and organizer's user ID)
 * Value: interaction object for editing the ephemeral message
 */
const activeOrganizerPanels = new Map<string, ButtonInteraction | ModalSubmitInteraction>();

/**
 * Register an active organizer panel for auto-refresh on key reactions
 */
export function registerOrganizerPanel(
    runId: string,
    userId: string,
    interaction: ButtonInteraction | ModalSubmitInteraction
): void {
    const key = `${runId}:${userId}`;
    activeOrganizerPanels.set(key, interaction);
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
 * Get the active organizer panel interaction for a run and user
 */
export function getOrganizerPanel(
    runId: string,
    userId: string
): ButtonInteraction | ModalSubmitInteraction | undefined {
    const key = `${runId}:${userId}`;
    return activeOrganizerPanels.get(key);
}

/**
 * Get all active organizer panels for a specific run (multiple organizers might have it open)
 */
export function getAllOrganizerPanelsForRun(runId: string): Array<{ userId: string; interaction: ButtonInteraction | ModalSubmitInteraction }> {
    const panels: Array<{ userId: string; interaction: ButtonInteraction | ModalSubmitInteraction }> = [];
    
    for (const [key, interaction] of activeOrganizerPanels.entries()) {
        const [storedRunId, userId] = key.split(':');
        if (storedRunId === runId) {
            panels.push({ userId, interaction });
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
