import { randomUUID } from 'node:crypto';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { z } from 'zod';

export const MIN_KEY_QUANTITY = 1;
export const MAX_KEY_QUANTITY = 10;
export const KEY_QUANTITY_INPUT_ID = 'quantity';

export const KeyQuantitySchema = z.string()
    .trim()
    .regex(/^\d+$/, 'Enter a whole number from 1 to 10.')
    .transform(value => Number(value))
    .pipe(z.number().int().min(MIN_KEY_QUANTITY).max(MAX_KEY_QUANTITY));

export interface KeyOfferUser {
    userId: string;
    quantity: number;
}

export type KeyOffersByType = Record<string, KeyOfferUser[]>;

export const KeyOfferResponseSchema = z.object({
    keyCounts: z.record(z.number().int().nonnegative()),
    keyOffers: z.record(z.array(z.object({
        userId: z.string().min(1),
        quantity: z.number().int().min(MIN_KEY_QUANTITY).max(MAX_KEY_QUANTITY),
    }))),
    quantity: z.number().int().min(MIN_KEY_QUANTITY).max(MAX_KEY_QUANTITY).optional(),
    removed: z.boolean().optional(),
});

const OffersByTypeSchema = z.record(z.array(z.object({
    userId: z.string().min(1),
    quantity: z.number().int().min(MIN_KEY_QUANTITY).max(MAX_KEY_QUANTITY),
})));

export const KeyReactionUsersResponseSchema = z.object({
    headcountKeys: z.record(z.array(z.string().min(1))),
    raidKeys: z.record(z.array(z.string().min(1))),
    keyUsers: z.record(z.array(z.string().min(1))),
    headcountOffers: OffersByTypeSchema,
    raidOffers: OffersByTypeSchema,
});

export type HeadcountKeyOfferStore = Map<string, Map<string, Map<string, number>>>;

export type KeyQuantityIntent =
    | {
        context: 'run';
        runId: string;
        userId: string;
        keyType: string;
    }
    | {
        context: 'headcount';
        messageId: string;
        userId: string;
        dungeonCode: string;
        keyType: string;
    };

interface StoredIntent {
    intent: KeyQuantityIntent;
    expiresAt: number;
}

const INTENT_TTL_MS = 15 * 60 * 1000;
const intents = new Map<string, StoredIntent>();
const refreshQueues = new Map<string, Promise<void>>();

const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [token, stored] of intents) {
        if (stored.expiresAt <= now) intents.delete(token);
    }
}, 60_000);
cleanupInterval.unref();

export function parseKeyQuantity(input: string): number | null {
    const result = KeyQuantitySchema.safeParse(input);
    return result.success ? result.data : null;
}

export function registerKeyQuantityIntent(intent: KeyQuantityIntent): string {
    const token = randomUUID();
    intents.set(token, { intent, expiresAt: Date.now() + INTENT_TTL_MS });
    return token;
}

export function resolveKeyQuantityIntent(token: string): KeyQuantityIntent | null {
    const stored = intents.get(token);
    if (!stored || stored.expiresAt <= Date.now()) {
        intents.delete(token);
        return null;
    }
    return stored.intent;
}

export function buildKeyQuantityModal(
    intent: KeyQuantityIntent,
    keyLabel: string,
    currentQuantity = MIN_KEY_QUANTITY
): ModalBuilder {
    const token = registerKeyQuantityIntent(intent);
    const quantityInput = new TextInputBuilder()
        .setCustomId(KEY_QUANTITY_INPUT_ID)
        .setLabel('How many keys? (1-10)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(2)
        .setValue(String(currentQuantity));

    return new ModalBuilder()
        .setCustomId(`keyqty:submit:${token}`)
        .setTitle(`${keyLabel} Quantity`.slice(0, 45))
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(quantityInput));
}

export function buildWithdrawKeyButton(intent: KeyQuantityIntent): ActionRowBuilder<ButtonBuilder> {
    const token = registerKeyQuantityIntent(intent);
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`keyqty:withdraw:${token}`)
            .setLabel('Withdraw key offer')
            .setStyle(ButtonStyle.Danger)
    );
}

export function parseKeyQuantityAction(customId: string): {
    action: 'submit' | 'withdraw';
    token: string;
} | null {
    const parsed = z.tuple([
        z.literal('keyqty'),
        z.enum(['submit', 'withdraw']),
        z.string().uuid(),
    ]).safeParse(customId.split(':'));
    return parsed.success ? { action: parsed.data[1], token: parsed.data[2] } : null;
}

export function getKeyOfferQuantity(
    store: HeadcountKeyOfferStore,
    dungeonCode: string,
    keyType: string,
    userId: string
): number | null {
    return store.get(dungeonCode)?.get(keyType)?.get(userId) ?? null;
}

export function setKeyOfferQuantity(
    store: HeadcountKeyOfferStore,
    dungeonCode: string,
    keyType: string,
    userId: string,
    quantity: number
): void {
    const validatedQuantity = z.number().int().min(MIN_KEY_QUANTITY).max(MAX_KEY_QUANTITY).parse(quantity);
    let dungeonOffers = store.get(dungeonCode);
    if (!dungeonOffers) {
        dungeonOffers = new Map();
        store.set(dungeonCode, dungeonOffers);
    }
    let keyOffers = dungeonOffers.get(keyType);
    if (!keyOffers) {
        keyOffers = new Map();
        dungeonOffers.set(keyType, keyOffers);
    }
    keyOffers.set(userId, validatedQuantity);
}

export function removeKeyOffer(
    store: HeadcountKeyOfferStore,
    dungeonCode: string,
    keyType: string,
    userId: string
): boolean {
    const dungeonOffers = store.get(dungeonCode);
    const keyOffers = dungeonOffers?.get(keyType);
    const removed = keyOffers?.delete(userId) ?? false;
    if (keyOffers?.size === 0) dungeonOffers?.delete(keyType);
    if (dungeonOffers?.size === 0) store.delete(dungeonCode);
    return removed;
}

export function totalKeyQuantity(users: Iterable<{ quantity: number }>): number {
    let total = 0;
    for (const user of users) total += user.quantity;
    return total;
}

export function formatKeyOfferUsers(users: readonly KeyOfferUser[]): string {
    return users.map(user => `<@${user.userId}> ×${user.quantity}`).join(', ');
}

export async function serializeKeyRefresh(contextKey: string, work: () => Promise<void>): Promise<void> {
    const previous = refreshQueues.get(contextKey) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>(resolve => { release = resolve; });
    refreshQueues.set(contextKey, current);
    await previous.catch(() => undefined);
    try {
        await work();
    } finally {
        release?.();
        if (refreshQueues.get(contextKey) === current) refreshQueues.delete(contextKey);
    }
}
