import { z } from 'zod';
import { applyEmbedModal, applyEmbedFieldAction } from './editing.js';
import { MessageFlags, PermissionFlagsBits, type AutocompleteInteraction, type ButtonInteraction, type ChannelSelectMenuInteraction, type ChatInputCommandInteraction, type Guild, type RoleSelectMenuInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { getMemberRoleIds, hasRequiredRoleOrHigher } from '../permissions/permissions.js';
import { BackendError } from '../utilities/http.js';
import { createLogger } from '../logging/logger.js';
import { EmbedActorSchema, EmbedConfigSchema, EmbedNameSchema, SnowflakeSchema, parseColor, type EmbedActor, type EmbedConfig } from './contract.js';
import * as api from './api.js';
import { createSession, editDraft, isDirty, sessions, SESSION_TTL, type EmbedSession } from './session.js';
import { builderMessage, editorModal, EDITORS } from './ui.js';
import { destinationChannel, sendEmbedCopy, saveManagedEmbed, publishManagedEmbed, deleteManagedEmbed } from './publication.js';

const logger = createLogger('EmbedBuilder');
type Component = ButtonInteraction | StringSelectMenuInteraction | ChannelSelectMenuInteraction | ModalSubmitInteraction;
type GuildInteraction = Component | RoleSelectMenuInteraction | ChatInputCommandInteraction | AutocompleteInteraction;
export async function embedActor(interaction: GuildInteraction): Promise<EmbedActor> {
    if (!interaction.guild) throw new Error('Use embed tools in a server.');
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!(await hasRequiredRoleOrHigher(member, 'moderator')).hasRole) throw new Error('You need Moderator permission or higher to manage saved embeds.');
    return EmbedActorSchema.parse({ actor_user_id: member.id, actor_roles: getMemberRoleIds(member), actor_has_admin_permission: member.permissions.has(PermissionFlagsBits.Administrator) });
}
export function embedError(error: unknown): string {
    if (error instanceof z.ZodError) return error.issues[0]?.message ?? 'Invalid embed input.';
    if (error instanceof BackendError) return error.status && error.status < 500 ? error.message : 'The backend is unavailable. Your draft is still open; try again shortly.';
    // Only application errors should be exposed; Discord responses can contain the request body.
    if (error instanceof Error && error.constructor === Error) return error.message;
    return 'Discord could not complete that action. Check permissions and try again; your draft is still open.';
}
export async function openBuilder(interaction: ChatInputCommandInteraction, savedId?: string, deleting = false): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let session: EmbedSession | undefined;
    try {
        const actor = await embedActor(interaction);
        const guildId = SnowflakeSchema.parse(interaction.guildId);
        const saved = savedId ? await api.getSavedEmbed(guildId, savedId, actor) : undefined;
        session = createSession(guildId, interaction.user.id, saved);
        if (deleting) session.mode = 'delete';
        const message = await interaction.editReply(builderMessage(session));
        session.messageId = message.id;
        logger.info(saved ? 'Saved embed opened for editing' : 'Embed builder created', { guildId, userId: session.ownerId, embedId: saved?.id });
    } catch (error) {
        if (session) sessions.delete(session.id);
        await interaction.editReply({ content: embedError(error), embeds: [], components: [] });
    }
}
/** Copy-only compatibility helper; canonical management uses publication.ts. */
export async function publishEmbed(guild: Guild, userId: string, channelId: string | undefined, config: EmbedConfig): Promise<string> {
    return (await sendEmbedCopy(guild, userId, channelId, config)).url;
}
async function feedback(interaction: Component, content: string): Promise<void> {
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
const Action = z.tuple([z.literal('emb'), z.string().uuid(), z.coerce.number().int().nonnegative(), z.string().min(1).max(40)]);

/** Global routing handles expired sessions as well as active ones; no per-message collectors. */
export async function handleEmbedInteraction(interaction: Component): Promise<void> {
    const parsed = Action.safeParse(interaction.customId.split(':'));
    const s = parsed.success ? sessions.get(parsed.data[1]) : undefined;
    if (!s || s.expiresAt <= Date.now()) {
        if (s && !s.busy) sessions.delete(s.id);
        logger.info('Expired builder interaction', { guildId: interaction.guildId, userId: interaction.user.id });
        await feedback(interaction, 'This embed builder session has expired. Reopen the saved embed or run /createembed again.');
        return;
    }
    if (s.ownerId !== interaction.user.id || s.guildId !== interaction.guildId || s.messageId !== interaction.message?.id) {
        logger.warn('Unauthorized builder interaction', { guildId: interaction.guildId, userId: interaction.user.id, embedId: s.saved?.id });
        await feedback(interaction, 'This builder belongs to someone else. Run /createembed to open your own.');
        return;
    }
    if (!parsed.success || s.busy) {
        await feedback(interaction, 'The builder changed or is processing another action. Use its latest controls.');
        return;
    }
    s.busy = true;
    const action = parsed.data[3];
    try {
        if (parsed.data[2] !== s.revision) {
            // Recover controls after a successful publish whose message refresh failed.
            // Never replay the stale action or a stale modal's field index.
            await interaction.deferUpdate();
            await embedActor(interaction);
            await interaction.editReply(builderMessage(s));
            await feedback(interaction, 'The builder changed. Its latest controls are now shown; please try your edit again.');
            return;
        }
        const opensModal = (interaction.isStringSelectMenu() && action === 'editor' && interaction.values[0] !== 'Timestamp')
            || (interaction.isButton() && (action === 'add-field' || action === 'edit-field' || (action === 'save' && !s.saved)));
        if (!opensModal) {
            if (interaction.isModalSubmit() && !interaction.isFromMessage()) throw new Error('Reopen this editor from the builder message.');
            await interaction.deferUpdate();
        }
        const actor = await embedActor(interaction);
        if (opensModal) {
            const editor = action === 'editor' && interaction.isStringSelectMenu() ? z.enum(EDITORS).parse(interaction.values[0])
                : z.enum(['add-field', 'edit-field', 'save']).parse(action);
            if (editor === 'add-field' && s.config.fields.length >= 25) throw new Error('This embed already has the maximum of 25 fields.');
            if (editor === 'edit-field' && !s.config.fields[s.selected]) throw new Error('Select a field first.');
            if (!interaction.isButton() && !interaction.isStringSelectMenu()) throw new Error('Use the latest builder controls.');
            await interaction.showModal(editorModal(s, editor));
            s.expiresAt = Date.now() + SESSION_TTL;
            return;
        }
        if (action === 'cancel') {
            await interaction.editReply({ content: 'Embed builder closed. Unsaved edits discarded. Saved embeds are unchanged.', embeds: [], components: [] });
            sessions.delete(s.id);
            return;
        }
        if (action === 'confirm-delete' && s.mode === 'delete' && s.saved) {
            if (!interaction.guild) throw new Error('Use this in a server.');
            const result = await deleteManagedEmbed(interaction.guild, s.saved, actor);
            s.saved = result.saved;
            s.notice = result.notice;
            if (result.deleted) {
                for (const [id, session] of sessions) {
                    if (session.guildId === s.guildId && session.saved?.id === s.saved.id) sessions.delete(id);
                }
                await interaction.editReply({ content: result.notice, embeds: [], components: [] });
            } else {
                s.revision++;
                await interaction.editReply(builderMessage(s));
            }
            return;
        }
        if (s.mode === 'delete') throw new Error('Use the delete confirmation controls.');
        const next = structuredClone(s);
        next.notice = undefined;
        if (interaction.isModalSubmit()) {
            const input = (id: string) => z.string().parse(interaction.fields.getTextInputValue(id));
            if (action === 'modal-save') {
                if (s.saved) throw new Error('Already saved. Use Save Changes.');
                next.saved = await api.saveEmbed(s.guildId, actor, s.config, { name: EmbedNameSchema.parse(input('name')) });
                // Preserve successful persistence even if editing the Discord message subsequently fails.
                s.saved = next.saved;
            } else {
                applyEmbedModal(next, action, input);
            }
        } else if (interaction.isChannelSelectMenu() && action === 'channel') {
            next.channelId = z.array(SnowflakeSchema).max(1).parse(interaction.values)[0];
            if (next.channelId && interaction.guild) await destinationChannel(interaction.guild, next.channelId);
        } else if (interaction.isStringSelectMenu() && action === 'select-field') {
            next.selected = z.coerce.number().int().min(0).max(s.config.fields.length - 1).parse(interaction.values[0]);
        } else if (interaction.isStringSelectMenu() && action === 'editor' && z.enum(EDITORS).parse(interaction.values[0]) === 'Timestamp') {
            editDraft(next, c => { c.timestamp = c.timestamp ? undefined : new Date().toISOString(); });
        } else if (interaction.isButton()) {
            switch (action) {
                case 'fields': next.mode = 'fields'; break;
                case 'main': next.mode = 'main'; break;
                case 'save': {
                    if (!s.saved) throw new Error('Choose a name before saving.');
                    if (!interaction.guild) throw new Error('Use this in a server.');
                    const result = await saveManagedEmbed(interaction.guild, s.saved, s.config, actor);
                    next.saved = s.saved = result.saved;
                    next.notice = s.notice = result.notice;
                    break;
                }
                case 'publish': case 'move': {
                    if (!interaction.guild) throw new Error('Use this in a server.');
                    if (!s.saved) throw new Error('Save this embed with a name before publishing so its message can be tracked.');
                    if (isDirty(s)) throw new Error('Use Save Changes before publishing or moving this embed.');
                    const result = await publishManagedEmbed(interaction.guild, s.saved, actor, s.channelId, action === 'move');
                    next.saved = s.saved = result.saved;
                    next.notice = s.notice = result.notice;
                    s.revision++;
                    break;
                }
                case 'remove-field': case 'inline': case 'up': case 'down':
                    applyEmbedFieldAction(next, action);
                    break;
                default: throw new Error('Unknown action. Use the latest builder controls.');
            }
        } else throw new Error('Unknown action. Use the latest builder controls.');
        EmbedConfigSchema.parse(next.config);
        next.revision = s.revision + 1;
        next.expiresAt = Date.now() + SESSION_TTL;
        await interaction.editReply(builderMessage(next));
        Object.assign(s, next);
    } catch (error) {
        logger.warn('Embed builder action failed', { guildId: s.guildId, userId: s.ownerId, embedId: s.saved?.id, action, errorType: error instanceof Error ? error.name : 'Unknown' });
        await feedback(interaction, embedError(error));
    } finally { s.busy = false; }
}
