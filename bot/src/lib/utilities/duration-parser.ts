import { ChatInputCommandInteraction } from 'discord.js';

/**
 * Duration unit type
 */
export type DurationUnit = 'm' | 'h' | 'd';

/**
 * Parsed duration result
 */
export interface ParsedDuration {
    value: number;
    unit: DurationUnit;
    minutes: number;
    hours: number;
    displayText: string;
}

/**
 * Parses a duration string (e.g., "30m", "5h", "2d") into structured data.
 * 
 * @param durationStr - Duration string to parse
 * @param allowMinutes - Whether to allow minute units (default: true)
 * @returns Parsed duration or null if invalid format
 * 
 * @example
 * const duration = parseDuration("5h");
 * if (!duration) {
 *     // Invalid format
 * }
 * console.log(duration.minutes); // 300
 * console.log(duration.displayText); // "5 hours"
 */
export function parseDuration(
    durationStr: string,
    allowMinutes = true
): ParsedDuration | null {
    const pattern = allowMinutes ? /^(\d+)(m|h|d)$/ : /^(\d+)(h|d)$/;
    const match = durationStr.trim().toLowerCase().match(pattern);
    
    if (!match) return null;
    
    const value = parseInt(match[1], 10);
    const unit = match[2] as DurationUnit;
    
    // Convert to minutes
    let minutes: number;
    let hours: number;
    
    if (unit === 'm') {
        minutes = value;
        hours = value / 60;
    } else if (unit === 'h') {
        minutes = value * 60;
        hours = value;
    } else { // 'd'
        minutes = value * 24 * 60;
        hours = value * 24;
    }
    
    // Generate display text
    let displayText: string;
    if (unit === 'm') {
        displayText = `${value} minute${value !== 1 ? 's' : ''}`;
    } else if (unit === 'h') {
        displayText = `${value} hour${value !== 1 ? 's' : ''}`;
    } else {
        displayText = `${value} day${value !== 1 ? 's' : ''}`;
    }
    
    return {
        value,
        unit,
        minutes,
        hours,
        displayText,
    };
}

/**
 * Parses and validates a duration string with automatic error responses.
 * 
 * @param interaction - Discord interaction
 * @param durationStr - Duration string to parse
 * @param options - Validation options
 * @returns Parsed duration or null if invalid (error sent)
 * 
 * @example
 * const duration = await parseDurationOrReply(interaction, "5h", {
 *     minMinutes: 60,
 *     maxMinutes: 43200,
 *     allowMinutes: false
 * });
 * if (!duration) return;
 */
export async function parseDurationOrReply(
    interaction: ChatInputCommandInteraction,
    durationStr: string,
    options: {
        minMinutes?: number;
        maxMinutes?: number;
        allowMinutes?: boolean;
    } = {}
): Promise<ParsedDuration | null> {
    const {
        minMinutes = 1,
        maxMinutes = 43200, // 30 days
        allowMinutes = true,
    } = options;
    
    const duration = parseDuration(durationStr, allowMinutes);
    
    if (!duration) {
        const examples = allowMinutes
            ? '• `30m` for 30 minutes\n• `5h` for 5 hours\n• `2d` for 2 days\n• `30d` for 30 days (maximum)'
            : '• `5h` for 5 hours\n• `2d` for 2 days\n• `30d` for 30 days (maximum)';
        
        await interaction.editReply(
            `❌ **Invalid Duration Format**\n\nPlease use format like:\n${examples}`
        );
        return null;
    }
    
    // Validate minimum
    if (duration.minutes < minMinutes) {
        const minDisplay = minMinutes < 60
            ? `${minMinutes} minute${minMinutes !== 1 ? 's' : ''}`
            : `${Math.floor(minMinutes / 60)} hour${Math.floor(minMinutes / 60) !== 1 ? 's' : ''}`;
        
        await interaction.editReply(`❌ Duration must be at least ${minDisplay}.`);
        return null;
    }
    
    // Validate maximum
    if (duration.minutes > maxMinutes) {
        const maxDays = Math.floor(maxMinutes / (24 * 60));
        const maxHours = Math.floor(maxMinutes / 60);
        
        await interaction.editReply(
            `❌ Duration cannot exceed ${maxDays} days (${maxHours} ${maxHours === 1 ? 'hour' : 'hours'}).`
        );
        return null;
    }
    
    return duration;
}

/**
 * Calculates a new expiration date by adding duration to an existing expiration.
 * Returns both the new expiration and the duration from now to the new expiration.
 * 
 * @param existingExpiration - Existing expiration date
 * @param additionalMinutes - Minutes to add
 * @returns New expiration date and minutes from now to new expiration
 */
export function calculateExtendedExpiration(
    existingExpiration: Date,
    additionalMinutes: number
): { newExpiration: Date; durationFromNowMinutes: number } {
    const newExpiration = new Date(existingExpiration.getTime() + additionalMinutes * 60 * 1000);
    const now = new Date();
    const durationFromNow = newExpiration.getTime() - now.getTime();
    const durationFromNowMinutes = Math.ceil(durationFromNow / (1000 * 60));
    
    return { newExpiration, durationFromNowMinutes };
}
