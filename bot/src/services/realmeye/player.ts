/**
 * RealmEye Player Data Types and Interfaces
 * Inspired by RealmEyeSharper's PlayerData structure
 */

/**
 * Result codes for RealmEye profile fetching operations.
 * Mirrors RealmEyeSharper's approach to error handling.
 */
export type RealmEyeResultCode = 
    | 'Success'           // Profile fetched and parsed successfully
    | 'ServiceUnavailable' // RealmEye is down or network error
    | 'NotFound'          // Player does not exist
    | 'Private'           // Profile exists but is private
    | 'Error';            // Other unexpected error

/**
 * Represents a RealmEye player profile.
 * Mirrors the structure from RealmEyeSharper's PlayerData class.
 * 
 * This interface focuses on the essential fields needed for verification.
 * Additional fields (rank, guild, characters, etc.) can be added later as needed.
 */
export interface RealmEyePlayerProfile {
    /**
     * The player's in-game name (IGN)
     */
    name: string;

    /**
     * Description lines from the player's profile.
     * RealmEye allows up to 3 description lines (stored in .line1, .line2, .line3 divs).
     * Like RealmEyeSharper's Description property (string[]).
     */
    descriptionLines: string[];

    /**
     * Result code indicating the fetch outcome.
     * Similar to RealmEyeSharper's pattern of returning status with data.
     */
    resultCode: RealmEyeResultCode;

    /**
     * Optional error message for non-Success result codes.
     */
    errorMessage?: string;
}
