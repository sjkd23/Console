import type { Guild, Message } from 'discord.js';
import { ChannelType } from 'discord.js';
import type { EmbedActor } from '../embeds/contract.js';
import { renderEmbed } from '../embeds/render.js';
import { createLogger } from '../logging/logger.js';
import * as api from './api.js';
import { fetchChannel, missing, noMentions, panelDestination, ticketButton, validateResources } from './discord.js';
import type { ConfigInput, TicketConfig } from './contract.js';

const logger = createLogger('TicketPanel');
const locks = new Set<string>();
export async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (locks.has(key)) throw new Error('This ticket panel is already being managed. Retry shortly.');
    locks.add(key); try { return await work(); } finally { locks.delete(key); }
}
const payload = (c: TicketConfig) => ({ embeds: [renderEmbed(c.panel_embed)], components: [ticketButton('create', c.id)], allowedMentions: noMentions });
async function tracked(guild: Guild, c: TicketConfig): Promise<Message | null> {
    if (guild.id !== c.guild_id) throw new Error('Wrong server.');
    if (!c.published_channel_id || !c.panel_message_id) return null;
    const channel = await fetchChannel(guild, c.published_channel_id);
    if (!channel) return null;
    if (channel.type !== ChannelType.GuildText || channel.guildId !== guild.id) throw new Error('Invalid tracked panel channel.');
    try {
        const message = await channel.messages.fetch({ message: c.panel_message_id, force: true, cache: false });
        if (message.author.id !== guild.client.user.id) throw new Error('The tracked panel does not belong to this bot.');
        return message;
    } catch (e) { if (missing(e)) return null; throw e; }
}
export interface PanelResult { config: TicketConfig; notice: string }
export async function savePanel(guild: Guild, actor: EmbedActor, input: ConfigInput, current?: TicketConfig): Promise<PanelResult> {
    return exclusive(current?.id ?? `${guild.id}:${actor.actor_user_id}:new`, async () => {
        const resources = await validateResources(guild, input);
        let config = await api.saveConfig(guild.id, actor, input, resources, current?.id, current?.revision);
        let notice = 'Ticket configuration saved. Opening embed changes apply to future tickets.';
        if (config.panel_message_id) {
            try {
                const message = await tracked(guild, config);
                if (message) {
                    await message.edit(payload(config));
                    logger.info('Ticket panel edited', { guildId: guild.id, configId: config.id, messageId: message.id });
                } else {
                    config = await api.manageConfig(guild.id, actor, config.id, config.revision, 'publication');
                    notice += ' The published panel is missing; its reference was cleared. Use Publish / Move explicitly.';
                    logger.info('Ticket panel missing/stale', { guildId: guild.id, configId: config.id });
                }
            } catch (error) {
                if (missing(error)) {
                    config = await api.manageConfig(guild.id, actor, config.id, config.revision, 'publication');
                    notice += ' The panel was deleted during saving. Use Publish / Move to republish.';
                } else notice += ' The Discord panel could not be updated. Check access, reopen this builder and Save Changes again.';
            }
        }
        if (config.published_channel_id && config.published_channel_id !== config.panel_channel_id) notice += ' Destination changed; use Publish / Move to move the panel.';
        return { config, notice };
    });
}
export async function publishPanel(guild: Guild, actor: EmbedActor, saved: TicketConfig): Promise<PanelResult> {
    return exclusive(saved.id, async () => {
        let config = await api.manageConfig(guild.id, actor, saved.id, saved.revision, 'claim');
        if (!config.enabled) return { config, notice: 'This ticket panel is disabled.' };
        let created: Message | undefined;
        try {
            const destination = await panelDestination(guild, config.panel_channel_id);
            const old = await tracked(guild, config);
            if (old && old.channelId === destination.id) {
                await old.edit(payload(config)); return { config, notice: `Updated the existing panel: ${old.url}` };
            }
            created = await destination.send(payload(config));
            try { config = await api.manageConfig(guild.id, actor, config.id, config.revision, 'publication', destination.id, created.id); }
            catch (error) {
                // Verify a potentially committed write before deleting its newly canonical message.
                const verified = await api.getConfig(guild.id, actor, config.id);
                if (verified.panel_message_id === created.id) config = verified;
                else { await created.delete(); throw error; }
            }
            if (old) {
                try { await old.delete(); }
                catch (e) {
                    if (!missing(e)) {
                        // Keep the canonical replacement, neutralize the obsolete button if deletion is forbidden.
                        try { await old.edit({ components: [] }); } catch { /* surfaced below */ }
                        return { config, notice: `Replacement published: ${created.url}. Old panel cleanup failed: ${old.url}. Remove that old message manually.` };
                    }
                }
            }
            logger.info(old ? 'Ticket panel moved' : 'Ticket panel published', { guildId: guild.id, configId: config.id, messageId: created.id });
            return { config, notice: `Panel ${old ? 'moved' : 'published'}: ${created.url}` };
        } catch {
            return { config, notice: `Publication could not finish. Reopen the builder to reconcile tracking before retrying.${created ? ` Check the replacement: ${created.url}` : ''}` };
        }
    });
}
export async function disablePanel(guild: Guild, actor: EmbedActor, saved: TicketConfig): Promise<PanelResult> {
    return exclusive(saved.id, async () => {
        let config = await api.manageConfig(guild.id, actor, saved.id, saved.revision, 'disable');
        try {
            const message = await tracked(guild, config);
            if (message) { try { await message.delete(); } catch (e) { if (!missing(e)) throw e; } }
            config = await api.manageConfig(guild.id, actor, config.id, config.revision, 'publication');
            return { config, notice: 'Ticket type disabled and panel removed. Existing tickets and transcripts are preserved.' };
        } catch { return { config, notice: 'Ticket type disabled. Panel cleanup failed; retry /deleteticket or remove the old panel manually. Its Create Ticket button is inactive.' }; }
    });
}
