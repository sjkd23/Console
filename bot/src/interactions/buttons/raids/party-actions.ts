import { ButtonInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { removeActiveParty } from '../../../lib/state/party-state.js';
import { logBotEvent } from '../../../lib/logging/bot-logger.js';
import { logPartyClosure, clearPartyLogThreadCache } from '../../../lib/logging/party-logger.js';

/**
 * Party Actions Handler
 * 
 * Handles button interactions for party finder posts.
 * Currently supports:
 * - Close: Allows party owner to close their party post
 */

/**
 * Handle party close button interaction
 * 
 * Validates that the user clicking the button is the party owner,
 * then updates the embed to show the party as closed, removes all
 * buttons, archives the thread, and removes the party from active tracking.
 * 
 * @param interaction - The button interaction from Discord
 * @param creatorId - The Discord user ID of the party creator (from button custom ID)
 */
export async function handlePartyClose(interaction: ButtonInteraction, creatorId: string) {
    // Only party leader can close
    if (interaction.user.id !== creatorId) {
        await interaction.reply({ 
            content: '❌ Only the party leader can close this party.', 
            ephemeral: true 
        });
        return;
    }

    const message = interaction.message;
    const embed = message.embeds[0];

    if (!embed) {
        await interaction.reply({ 
            content: '❌ Could not find the party embed.', 
            ephemeral: true 
        });
        return;
    }

    try {
        // Extract party name from the message content (format: "**Party:** {name}")
        const messageContent = message.content || '';
        const partyNameMatch = messageContent.match(/\*\*Party:\*\*\s*([^\|]+)/);
        const partyName = partyNameMatch ? partyNameMatch[1].trim() : 'Unknown Party';

        // Update embed to show party as closed
        const newEmbed = new EmbedBuilder(embed.toJSON());
        newEmbed.setColor(0xED4245); // Red for Closed
        newEmbed.setTitle('❌ Party Closed');

        // Remove all action buttons/components when closed
        await message.edit({ embeds: [newEmbed], components: [] });
        
        // Remove from active parties tracking
        removeActiveParty(creatorId);
        
        // Archive thread if exists
        if (message.thread) {
            try {
                await message.thread.setLocked(true);
                await message.thread.setArchived(true);
            } catch (err) {
                console.error('[Party] Failed to archive thread:', err);
                // Non-critical error - continue with success response
            }
        }

        // Log party closure to raid-log channel thread
        if (interaction.guildId) {
            try {
                await logPartyClosure(
                    interaction.client,
                    {
                        guildId: interaction.guildId,
                        ownerId: creatorId,
                        ownerUsername: interaction.user.username,
                        partyName: partyName,
                        messageId: message.id
                    },
                    interaction.user.id
                );
                
                // Clear the thread cache after party closes
                clearPartyLogThreadCache({
                    guildId: interaction.guildId,
                    ownerId: creatorId,
                    ownerUsername: interaction.user.username,
                    partyName: partyName,
                    messageId: message.id
                });
            } catch (err) {
                console.error('[Party] Failed to log party closure to raid-log:', err);
                // Non-critical error - don't fail the operation
            }
        }

        // Log to bot-log channel (brief notification)
        if (interaction.guildId) {
            await logBotEvent(
                interaction.client,
                interaction.guildId,
                '🚪 Party Closed',
                `Party closed by <@${interaction.user.id}>`,
                {
                    color: 0xED4245,
                    fields: [
                        { name: 'Party Name', value: partyName, inline: true },
                        { name: 'Channel', value: `<#${interaction.channelId}>`, inline: true },
                        { name: 'Message', value: `[View](${message.url})`, inline: true }
                    ]
                }
            ).catch(err => {
                console.error('[Party] Failed to log party closure to bot-log:', err);
                // Non-critical error - don't fail the operation
            });
        }

        await interaction.reply({ content: '✅ Party closed successfully.', ephemeral: true });
        
    } catch (err) {
        console.error('[Party] Error closing party:', err);
        
        // Try to respond with error
        const errorMsg = '❌ An error occurred while closing the party. Please try again.';
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: errorMsg, ephemeral: true });
        } else {
            await interaction.reply({ content: errorMsg, ephemeral: true });
        }
    }
}
