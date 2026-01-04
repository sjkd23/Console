// backend/src/lib/services/early-loc-service.ts
import { createLogger } from '../logging/logger.js';
import { query } from '../../db/pool.js';

const logger = createLogger('EarlyLocService');

export interface EarlyLocChangeInfo {
    shouldNotify: boolean;
    isInitialSet: boolean;
    party: string | null;
    location: string | null;
}

/**
 * Check if party/location changes warrant an early-loc notification.
 * Returns info about whether to notify and if it's an initial SET or CHANGED.
 * 
 * Logic:
 * - Initial SET: Both party AND location were null, now at least one is set
 * - CHANGED: At least one value changed from a previous non-null state
 * - No notification: Values didn't actually change
 */
export async function checkEarlyLocNotification(
    runId: number,
    newParty: string | null,
    newLocation: string | null
): Promise<EarlyLocChangeInfo> {
    const res = await query<{ party: string | null; location: string | null }>(
        `SELECT party, location FROM run WHERE id = $1::bigint`,
        [runId]
    );

    if (res.rowCount === 0) {
        return {
            shouldNotify: false,
            isInitialSet: false,
            party: newParty,
            location: newLocation
        };
    }

    const current = res.rows[0];
    
    // Check if values actually changed
    const partyChanged = current.party !== newParty;
    const locationChanged = current.location !== newLocation;
    
    if (!partyChanged && !locationChanged) {
        // No change, no notification
        return {
            shouldNotify: false,
            isInitialSet: false,
            party: newParty,
            location: newLocation
        };
    }

    // Determine if this is initial SET or CHANGED
    // SET: Both party AND location will be non-null for the first time after this update
    // CHANGED: Both were already non-null before, and at least one is changing
    const wasBothSet = current.party !== null && current.location !== null;
    const willBeBothSet = newParty !== null && newLocation !== null;
    const isInitialSet = !wasBothSet && willBeBothSet;

    return {
        shouldNotify: true,
        isInitialSet,
        party: newParty,
        location: newLocation
    };
}

