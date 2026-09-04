import { describe, expect, it } from 'vitest';
import { getDungeonKeyTypes, isKeyTypeForSelectedDungeons, KeyQuantitySchema } from './key-offers.js';

describe('run key offer validation', () => {
    it('maps ordinary and special dungeon keys', () => {
        expect(getDungeonKeyTypes('NEST')).toEqual(['NEST_KEY']);
        expect(getDungeonKeyTypes('LOST_HALLS')).toEqual(['CULT_KEY', 'VOID_KEY', 'VIAL_OF_PURE_DARKNESS']);
        expect(getDungeonKeyTypes('ORYX_3')).toEqual(['WC_INC', 'SHIELD_RUNE', 'SWORD_RUNE', 'HELM_RUNE']);
        expect(getDungeonKeyTypes('REALM_DUNGEON')).toEqual([]);
    });

    it('scopes a key type to the selected run dungeons', () => {
        expect(isKeyTypeForSelectedDungeons('FUNGAL_CAVERN_KEY', ['NEST', 'FUNGAL_CAVERN'])).toBe(true);
        expect(isKeyTypeForSelectedDungeons('SHATTERS_KEY', ['NEST', 'FUNGAL_CAVERN'])).toBe(false);
    });

    it('allows only integer quantities from one through ten', () => {
        expect(KeyQuantitySchema.safeParse(1).success).toBe(true);
        expect(KeyQuantitySchema.safeParse(10).success).toBe(true);
        for (const value of [0, 11, -1, 1.5, '2']) expect(KeyQuantitySchema.safeParse(value).success).toBe(false);
    });
});
