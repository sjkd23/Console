// Mirrored in backend/src/lib/embeds/contract.ts; parity is checked by tests.
// Standalone service builds intentionally do not import across Docker contexts.
import { z } from 'zod';

export const LIMITS = { title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, total: 6000 } as const;
const text = (label: string, max: number) => z.string().min(1, `${label} cannot be empty.`)
    .max(max, `${label}: Discord allows up to ${max} characters.`)
    .refine(value => value.trim().length > 0, `${label} cannot be blank.`);
export const SnowflakeSchema = z.string().regex(/^\d{17,20}$/, 'Invalid Discord ID.');
export const EmbedUrlSchema = z.string().max(2048).url('Enter a valid HTTP or HTTPS URL.').refine(value => {
    try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !/\s/.test(value);
    } catch { return false; }
}, 'Use an HTTP or HTTPS URL without spaces or credentials.');
export const EmbedNameSchema = z.string().trim().toLowerCase().min(1).max(64)
    .regex(/^[a-z0-9]+(?:[ -][a-z0-9]+)*$/, 'Use letters, numbers, spaces or hyphens (maximum 64 characters).');
export const EmbedFieldSchema = z.object({
    name: text('Field name', LIMITS.fieldName), value: text('Field value', LIMITS.fieldValue), inline: z.boolean().default(false),
}).strict();
const Shape = z.object({
    title: text('Title', LIMITS.title).optional(), description: text('Description', LIMITS.description).optional(),
    color: z.number().int().min(0).max(0xffffff).optional(), url: EmbedUrlSchema.optional(),
    fields: z.array(EmbedFieldSchema).max(LIMITS.fields, 'This embed already has the maximum of 25 fields.').default([]),
    footer: z.object({ text: text('Footer', LIMITS.footer), icon_url: EmbedUrlSchema.optional() }).strict().optional(),
    author: z.object({ name: text('Author name', LIMITS.author), icon_url: EmbedUrlSchema.optional(), url: EmbedUrlSchema.optional() }).strict().optional(),
    thumbnail: z.object({ url: EmbedUrlSchema }).strict().optional(), image: z.object({ url: EmbedUrlSchema }).strict().optional(),
    timestamp: z.string().datetime().optional(),
}).strict();
export type EmbedConfig = z.infer<typeof Shape>;
export function embedLength(embed: EmbedConfig): number {
    return (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0)
        + (embed.author?.name.length ?? 0) + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
}
export const EmbedConfigSchema = Shape.superRefine((embed, ctx) => {
    if (embedLength(embed) > LIMITS.total) ctx.addIssue({ code: 'custom', message: 'The entire embed must contain at most 6000 text characters.' });
    if (!embed.title && !embed.description && !embed.fields.length && !embed.image && !embed.thumbnail && !embed.author && !embed.footer) {
        ctx.addIssue({ code: 'custom', message: 'Keep at least a title, description, field, image, thumbnail, author or footer.' });
    }
});
export function parseColor(value: string): number | undefined {
    if (!value.trim()) return undefined;
    const hex = z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'Enter six hex digits, such as #5865F2, or leave blank to clear.').parse(value.trim());
    return Number.parseInt(hex.replace('#', ''), 16);
}
export const SavedEmbedSchema = z.object({
    id: z.string().uuid(), guild_id: SnowflakeSchema, name: EmbedNameSchema, config: EmbedConfigSchema,
    created_by: SnowflakeSchema, created_at: z.string().datetime(), updated_at: z.string().datetime(), revision: z.number().int().positive(),
    published_channel_id: SnowflakeSchema.nullable().default(null),
    published_message_id: SnowflakeSchema.nullable().default(null),
});
export const PublicationSchema = z.object({ guild_id: SnowflakeSchema, channel_id: SnowflakeSchema, message_id: SnowflakeSchema }).strict();
export type EmbedPublication = z.infer<typeof PublicationSchema>;
export type SavedEmbed = z.infer<typeof SavedEmbedSchema>;
export const EmbedListSchema = z.object({
    embeds: z.array(SavedEmbedSchema.omit({ config: true })), has_more: z.boolean(),
});
export const EmbedActorSchema = z.object({
    actor_user_id: SnowflakeSchema, actor_roles: z.array(SnowflakeSchema), actor_has_admin_permission: z.boolean(),
});
export type EmbedActor = z.infer<typeof EmbedActorSchema>;
