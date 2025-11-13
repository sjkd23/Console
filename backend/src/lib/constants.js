/**
 * Small, shared constants for the backend.
 * Keep these as the single source of truth for any closed sets.
 * If you change values here, mirror them in the bot.
 */
export const RUN_STATUS = ['open', 'live', 'ended'];
export const REACTION_STATES = ['join'];
/**
 * Discord Snowflake: numeric string of ~17–19 digits.
 * We accept a future-proof window of 15–22 digits.
 */
export const SNOWFLAKE_REGEX = /^[0-9]{15,22}$/;
export function isSnowflake(value) {
    return typeof value === 'string' && SNOWFLAKE_REGEX.test(value);
}
/**
 * Optional, sane limits used by request validation.
 * (Tune as you like; these are not enforced by the DB automatically.)
 */
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_LOCATION_NOTE_LENGTH = 200;
/* -------------------------------------------
 * If you’re using Zod for route validation,
 * these helpers keep schemas aligned with the constants.
 * (Safe to remove if you prefer not to depend on Zod here.)
 * ------------------------------------------*/
import { z } from 'zod';
export const zRunStatus = z.enum(RUN_STATUS);
export const zReactionState = z.enum(REACTION_STATES);
export const zSnowflake = z
    .string()
    .regex(SNOWFLAKE_REGEX, 'expected a Discord snowflake id');
export const zOptionalSnowflake = z
    .string()
    .regex(SNOWFLAKE_REGEX, 'expected a Discord snowflake id')
    .optional();
export const zDescription = z
    .string()
    .trim()
    .max(MAX_DESCRIPTION_LENGTH)
    .optional();
export const zLocationNote = z
    .string()
    .trim()
    .max(MAX_LOCATION_NOTE_LENGTH)
    .optional();
