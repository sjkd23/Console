/**
 * Progress bar utilities for creating visual progress indicators in embeds
 */

/**
 * Creates a progress bar using emoji blocks
 * @param length Total length of the progress bar (in blocks)
 * @param progress Progress value between 0 and 1 (e.g., 0.5 for 50%)
 * @param filledEmoji Emoji to use for filled portions (default: '█')
 * @param emptyEmoji Emoji to use for empty portions (default: '░')
 * @returns A string representing the progress bar
 */
export function createProgressBar(
    length: number,
    progress: number,
    filledEmoji: string = '█',
    emptyEmoji: string = '░'
): string {
    // Clamp progress between 0 and 1
    const clampedProgress = Math.max(0, Math.min(1, progress));
    
    // Calculate how many blocks should be filled
    const filledBlocks = Math.round(length * clampedProgress);
    const emptyBlocks = length - filledBlocks;
    
    // Build the progress bar string
    const filled = filledEmoji.repeat(filledBlocks);
    const empty = emptyEmoji.repeat(emptyBlocks);
    
    return filled + empty;
}

/**
 * Formats a percentage value for display
 * @param progress Progress value between 0 and 1
 * @param decimals Number of decimal places (default: 2)
 * @returns Formatted percentage string (e.g., "75.50%")
 */
export function formatPercentage(progress: number, decimals: number = 2): string {
    const clampedProgress = Math.max(0, Math.min(1, progress));
    const percentage = clampedProgress * 100;
    return percentage.toFixed(decimals) + '%';
}

/**
 * Creates a progress bar with percentage label
 * @param length Total length of the progress bar (in blocks)
 * @param progress Progress value between 0 and 1
 * @returns Progress bar with percentage (e.g., "████░░░░ 50.00%")
 */
export function createProgressBarWithPercentage(
    length: number,
    progress: number
): string {
    const bar = createProgressBar(length, progress);
    const percentage = formatPercentage(progress);
    return `${bar} ${percentage}`;
}
