import { ChannelType, PermissionFlagsBits, type Guild, type Message } from 'discord.js';
import { z } from 'zod';
import * as api from './api.js';
import { SnowflakeSchema, type EmbedActor, type EmbedConfig, type SavedEmbed } from './contract.js';
import { renderEmbed } from './render.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('EmbedPublication');
// The deployment has one bot process. Serialize the entire DB + Discord workflow,
// not just one builder session, so a later Save cannot overtake an earlier edit.
const active = new Set<string>();
async function exclusive<T>(guildId: string, id: string, work: () => Promise<T>): Promise<T> {
    const key = `${guildId}:${id}`;
    if (active.has(key)) throw new Error('This saved embed is already being managed. Wait for that action to finish and try again.');
    active.add(key);
    try { return await work(); } finally { active.delete(key); }
}
const missing = (error: unknown) => z.object({ code: z.union([z.literal(10003), z.literal(10008)]) }).safeParse(error).success;
function failure(error: unknown): string {
    const parsed = z.object({ code: z.union([z.number(), z.string()]) }).safeParse(error);
    return parsed.success ? String(parsed.data.code) : error instanceof Error ? error.name : 'Unknown';
}
function log(event: string, saved: SavedEmbed, error?: unknown) {
    logger.warn(event, { guildId: saved.guild_id, embedId: saved.id, name: saved.name,
        channelId: saved.published_channel_id, messageId: saved.published_message_id, failure: error === undefined ? undefined : failure(error) });
}
function assertGuild(guild: Guild, saved: SavedEmbed): void {
    if (saved.guild_id !== guild.id) throw new Error('That saved embed belongs to another server.');
}
export async function destinationChannel(guild: Guild, channelId: string | undefined) {
    if (!channelId) throw new Error('Select a destination channel before publishing.');
    const channel = await guild.channels.fetch(SnowflakeSchema.parse(channelId), { force: true });
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guild.id) throw new Error('The destination channel was deleted or is not a server text channel. Select another channel.');
    return channel;
}
/** Copy-only sending for future consumers. Does not read or change canonical tracking. */
export async function sendEmbedCopy(guild: Guild, userId: string, channelId: string | undefined, config: EmbedConfig): Promise<Message> {
    const embed = renderEmbed(config);
    const channel = await destinationChannel(guild, channelId);
    const bot = await guild.members.fetchMe();
    const member = await guild.members.fetch(userId);
    const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (!channel.permissionsFor(bot)?.has(needed)) throw new Error('I need View Channel, Send Messages and Embed Links in that channel.');
    if (!channel.permissionsFor(member)?.has(needed)) throw new Error('You need View Channel, Send Messages and Embed Links in that channel.');
    return channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}
/** Fetch only through the current guild and mutate only this bot's tracked message. */
async function trackedMessage(guild: Guild, saved: SavedEmbed): Promise<Message | null> {
    assertGuild(guild, saved);
    if (!saved.published_channel_id || !saved.published_message_id) return null;
    try {
        const channel = await guild.channels.fetch(saved.published_channel_id, { force: true });
        if (!channel) return null;
        if (channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) throw new Error('The tracked channel is not a text channel in this server.');
        const message = await channel.messages.fetch({ message: saved.published_message_id, force: true, cache: false });
        if (message.guildId !== guild.id || message.channelId !== saved.published_channel_id || message.author.id !== guild.client.user?.id) {
            throw new Error('The tracked message does not belong to this bot in this server.');
        }
        return message;
    } catch (error) { if (missing(error)) return null; throw error; }
}
async function removeMessage(message: Message, saved: SavedEmbed): Promise<void> {
    try { await message.delete(); }
    catch (error) { if (!missing(error)) throw error; log('Missing published message reconciled during deletion', saved); }
}
interface Result { saved: SavedEmbed; notice: string; deleted?: boolean }
async function reconcile(saved: SavedEmbed, actor: EmbedActor): Promise<SavedEmbed> {
    let updated: SavedEmbed;
    try { updated = await api.setEmbedPublication(saved.guild_id, saved.id, saved.revision, null, actor); }
    catch (error) {
        const verified = await api.getSavedEmbed(saved.guild_id, saved.id, actor);
        if (verified.published_message_id !== null) throw error;
        updated = verified;
    }
    log('Missing published message/channel reconciled', saved);
    return updated;
}
export async function saveManagedEmbed(guild: Guild, saved: SavedEmbed, config: EmbedConfig, actor: EmbedActor): Promise<Result> {
    assertGuild(guild, saved);
    return exclusive(guild.id, saved.id, async () => {
        // A rejected stale save must never reach Discord.
        let current = await api.saveEmbed(guild.id, actor, config, saved);
        if (!current.published_message_id) return { saved: current, notice: 'Saved configuration.' };
        try {
            const message = await trackedMessage(guild, current);
            if (!message) {
                current = await reconcile(current, actor);
                return { saved: current, notice: 'Saved configuration. The previously published message or channel no longer exists; its reference was cleared. You can publish again.' };
            }
            try { await message.edit({ embeds: [renderEmbed(current.config)], allowedMentions: { parse: [] } }); }
            catch (error) {
                if (!missing(error)) throw error;
                current = await reconcile(current, actor);
                return { saved: current, notice: 'Saved configuration. The published message was deleted during the update; its reference was cleared. You can publish again.' };
            }
            logger.info('Published embed updated', { guildId: guild.id, embedId: current.id, name: current.name, channelId: current.published_channel_id, messageId: current.published_message_id });
            return { saved: current, notice: 'Saved configuration and updated the existing published message.' };
        } catch (error) {
            log('Saved configuration but published message update failed', current, error);
            return { saved: current, notice: 'Configuration saved, but updating or reconciling the published Discord message failed. No new message was sent. Check access and use Save Changes to retry.' };
        }
    });
}
export async function publishManagedEmbed(guild: Guild, saved: SavedEmbed, actor: EmbedActor, channelId: string | undefined, move: boolean): Promise<Result> {
    assertGuild(guild, saved);
    if (!channelId) throw new Error('Select a destination channel before publishing.');
    return exclusive(guild.id, saved.id, async () => {
        let current = await api.claimSavedEmbed(guild.id, saved.id, saved.revision, actor);
        try {
            const old = await trackedMessage(guild, current);
            if (!old && current.published_message_id) current = await reconcile(current, actor);
            if (old && channelId === current.published_channel_id) return { saved: current, notice: 'Already published. Use Save Changes to update that message; no duplicate was sent.' };
            if (old && !move) return { saved: current, notice: 'Already published in another channel. Use Move Published Embed to explicitly relocate it.' };
            const previous = current;
            const created = await sendEmbedCopy(guild, actor.actor_user_id, channelId, current.config);
            try {
                current = await api.setEmbedPublication(guild.id, current.id, current.revision,
                    { guild_id: guild.id, channel_id: channelId, message_id: created.id }, actor);
            } catch (error) {
                // A timeout may mean the write committed. Resolve that before deleting a
                // potentially canonical message. If verification is unavailable, retain it.
                let verified: SavedEmbed;
                try { verified = await api.getSavedEmbed(guild.id, current.id, actor); }
                catch {
                    log('Publication persistence uncertain; newly created message retained', { ...current, published_channel_id: channelId, published_message_id: created.id }, error);
                    return { saved: current, notice: `Discord created ${created.url}, but tracking could not be confirmed. The old message was retained. Reopen this embed and check that message before retrying.` };
                }
                if (verified.published_message_id === created.id && verified.published_channel_id === channelId) current = verified;
                else {
                    try { await removeMessage(created, current); }
                    catch (cleanupError) {
                        log('Untracked publication cleanup failed', { ...current, published_channel_id: channelId, published_message_id: created.id }, cleanupError);
                        return { saved: verified, notice: `Publication tracking failed and cleanup failed. Remove the untracked copy at ${created.url} manually. The old post was retained.` };
                    }
                    log('Publication persistence failed; new message removed', current, error);
                    return { saved: verified, notice: 'Publication tracking failed. The new message was removed and the old post was retained. Reopen the saved embed before retrying.' };
                }
            }
            if (old) {
                try { await removeMessage(old, previous); }
                catch (error) {
                    log('Move could not remove old published message', previous, error);
                    // Restore the old canonical pointer before removing the replacement.
                    try {
                        try {
                            current = await api.setEmbedPublication(guild.id, current.id, current.revision,
                                { guild_id: guild.id, channel_id: previous.published_channel_id!, message_id: previous.published_message_id! }, actor);
                        } catch (rollbackError) {
                            current = await api.getSavedEmbed(guild.id, current.id, actor);
                            if (current.published_channel_id !== previous.published_channel_id || current.published_message_id !== previous.published_message_id) throw rollbackError;
                        }
                        await removeMessage(created, current);
                        return { saved: current, notice: 'Move failed because the old message could not be deleted. The old publication was restored and the replacement removed.' };
                    } catch (rollbackError) {
                        log('Move rollback or replacement cleanup failed', current, rollbackError);
                        return { saved: current, notice: `Move cleanup failed. Check ${old.url} and ${created.url}. Reopen this embed to confirm its current tracking before retrying.` };
                    }
                }
            }
            logger.info('Canonical embed published', { guildId: guild.id, embedId: current.id, name: current.name, channelId, messageId: created.id, moved: Boolean(old) });
            return { saved: current, notice: `${old ? 'Moved' : 'Published'}: ${created.url}` };
        } catch (error) {
            log('Canonical embed publication failed', current, error);
            return { saved: current, notice: 'Publication failed. The old tracked post was retained. Check the selected channel, permissions and destination for an unconfirmed send before retrying.' };
        }
    });
}
export async function deleteManagedEmbed(guild: Guild, saved: SavedEmbed, actor: EmbedActor): Promise<Result> {
    assertGuild(guild, saved);
    return exclusive(guild.id, saved.id, async () => {
        const current = await api.claimSavedEmbed(guild.id, saved.id, saved.revision, actor);
        try {
            const message = await trackedMessage(guild, current);
            if (message) await removeMessage(message, current);
            else if (current.published_message_id) log('Missing publication reconciled during saved embed deletion', current);
            await api.deleteSavedEmbed(guild.id, current.id, current.revision, actor);
            return { saved: current, deleted: true, notice: `Deleted saved embed: ${current.name}, including its tracked Discord message if present.` };
        } catch (error) {
            log('Saved embed deletion incomplete', current, error);
            return { saved: current, notice: 'Deletion could not finish. The saved configuration was retained; the Discord message may already have been removed. Check access/references and retry deletion.' };
        }
    });
}
