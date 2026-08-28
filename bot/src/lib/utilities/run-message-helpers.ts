/**
 * Utilities for building run message content
 * Consolidates duplicate logic for formatting public run messages
 */

export type O3Stage = 'closed' | 'miniboss' | 'third_room';

export function isO3RealmClosedStage(o3Stage?: string | null): boolean {
    return o3Stage === 'closed'
        || o3Stage === 'miniboss'
        || o3Stage === 'third_room';
}

/**
 * Builds the public run message content with @here ping and optional party/location
 * @param party - Optional party name
 * @param location - Optional location/server
 * @param additionalPings - Optional array of role IDs to ping
 * @param o3Stage - Optional persisted O3 progression stage
 * @returns Formatted message content string
 */
export function buildRunMessageContent(
    party?: string | null,
    location?: string | null,
    additionalPings?: string[],
    o3Stage?: O3Stage | null
): string {
    let content = '@here';
    
    // Add additional role pings if provided
    if (additionalPings && additionalPings.length > 0) {
        for (const roleId of additionalPings) {
            content += ` <@&${roleId}>`;
        }
    }
    
    if (isO3RealmClosedStage(o3Stage)) {
        content += ' 🔒 **REALM CLOSED** 🔒';
    } else if (party && location) {
        content += ` Party: **${party}** | Location: **${location}**`;
    } else if (party) {
        content += ` Party: **${party}**`;
    } else if (location) {
        content += ` Location: **${location}**`;
    }
    
    return content;
}
