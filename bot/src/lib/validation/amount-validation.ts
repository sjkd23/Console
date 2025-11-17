// bot/src/lib/validation/amount-validation.ts

/**
 * Validation utilities for amount inputs across logging commands
 */

/**
 * Validates and caps an amount for run/key logging operations
 * @param amount The amount to validate
 * @param maxValue The maximum allowed value (default: 99 for double digits)
 * @returns The capped amount or null if invalid
 */
export function validateAndCapAmount(amount: number, maxValue: number): number | null {
    // Reject zero
    if (amount === 0) {
        return null;
    }

    // Cap positive values at maxValue
    if (amount > 0) {
        return Math.min(amount, maxValue);
    }

    // Cap negative values at -maxValue
    if (amount < 0) {
        return Math.max(amount, -maxValue);
    }

    return amount;
}

/**
 * Get validation error message for an amount
 */
export function getAmountValidationError(amount: number, maxValue: number, itemName: string): string | null {
    if (amount === 0) {
        return `❌ Amount cannot be zero.`;
    }

    if (Math.abs(amount) > maxValue) {
        return `❌ Amount cannot exceed ${maxValue}. Your input (${Math.abs(amount)}) has been capped.`;
    }

    return null;
}

/**
 * Caps for different logging types
 */
export const CAPS = {
    RUN_KEY: 99,      // Double digits for /logrun and /logkey
    POINTS_QUOTA: 999 // Triple digits for /addpoints and /addquotapoints
} as const;
