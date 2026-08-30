/**
 * Format a number for display, showing decimals only when necessary
 * Examples:
 * - 10.00 -> "10"
 * - 10.50 -> "10.5"
 * - 10.55 -> "10.55"
 * - 0.5 -> "0.5"
 */
export function formatPoints(value: number): string {
    // Round to 2 decimal places to handle floating point precision issues
    const rounded = Math.round(value * 100) / 100;
    
    // If it's a whole number, show no decimals
    if (Number.isInteger(rounded)) {
        return rounded.toString();
    }
    
    // If it has decimals, show them (up to 2 places, removing trailing zeros)
    return rounded.toFixed(2).replace(/\.?0+$/, '');
}

export function formatPointAmount(value: number): string {
    return `${formatPoints(value)} ${value === 1 ? 'point' : 'points'}`;
}
