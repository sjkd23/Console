// bot/src/commands/help.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
} from 'discord.js';
import type { SlashCommand } from './_types.js';

/**
 * /help - Display information about all available bot commands
 * Organizer+ command
 */
export const help: SlashCommand = {
    requiredRole: 'organizer',
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('View information about all available bot commands (Organizer+)')
        .addStringOption(option =>
            option
                .setName('category')
                .setDescription('Filter commands by category')
                .setRequired(false)
                .addChoices(
                    { name: 'All Commands', value: 'all' },
                    { name: 'Raid Management', value: 'raids' },
                    { name: 'Moderation', value: 'moderation' },
                    { name: 'Configuration', value: 'config' },
                    { name: 'Statistics', value: 'stats' },
                    { name: 'Utility', value: 'utility' }
                )
        ),

    async run(interaction: ChatInputCommandInteraction) {
        const category = interaction.options.getString('category') ?? 'all';

        // Build the help embed
        const embed = new EmbedBuilder()
            .setTitle('📚 Bot Command Help')
            .setColor(0x5865F2)
            .setTimestamp();

        // Raid Management Commands
        if (category === 'all' || category === 'raids') {
            embed.addFields({
                name: '🗺️ Raid Management',
                value: 
                    '**`/run`** - Create new raid run (Organizer+)\n' +
                    '**`/logrun`** - Manually log run completion for quota (Organizer+)\n' +
                    '**`/logkey`** - Log key pops for raider (Organizer+)\n',
                inline: false
            });
        }

        // Statistics Commands
        if (category === 'all' || category === 'stats') {
            embed.addFields({
                name: '📊 Statistics',
                value:
                    '**`/stats`** - View quota statistics (Verified Raider+)\n',
                inline: false
            });
        }

        // Moderation Commands (split into two fields due to Discord's 1024 char limit)
        if (category === 'all' || category === 'moderation') {
            embed.addFields({
                name: '🛡️ Moderation - Verification',
                value:
                    '**`/verify`** - Verify member with ROTMG IGN (Security+)\n' +
                    '**`/unverify`** - Remove verification (Security+)\n' +
                    '**`/editname`** - Update verified member\'s IGN (Security+)\n',
                inline: false
            });
            embed.addFields({
                name: '🛡️ Moderation - Punishments',
                value:
                    '**`/warn`** - Issue warning (Security+)\n' +
                    '**`/suspend`** - Suspend member with duration (Security+)\n' +
                    '**`/unsuspend`** - Remove active suspension (Officer+)\n' +
                    '**`/removepunishment`** - Remove punishment by ID (Officer+)\n' +
                    '**`/checkpunishments`** - View punishment history (Security+)\n',
                inline: false
            });
            embed.addFields({
                name: '🛡️ Moderation - Points',
                value:
                    '**`/addpoints`** - Manually adjust raider points (Officer+)\n' +
                    '**`/addquotapoints`** - Manually adjust quota points (Officer+)\n',
                inline: false
            });
            embed.addFields({
                name: '🛡️ Moderation - Roles',
                value:
                    '**`/addrole`** - Promote member by adding staff role (Officer+)\n' +
                    '**`/addnote`** - Add moderation note to member (Security+)\n',
                inline: false
            });
        }

        // Configuration Commands
        if (category === 'all' || category === 'config') {
            embed.addFields({
                name: '⚙️ Configuration',
                value:
                    '**`/setroles`** - Configure role mappings (Moderator+)\n' +
                    '**`/setchannels`** - Configure channel mappings (Moderator+)\n' +
                    '**`/configquota`** - Configure quota requirements (Moderator+)\n' +
                    '**`/configpoints`** - Configure raider points (Moderator+)\n' +
                    '**`/syncteam`** - Sync Team role for all members (Administrator)\n',
                inline: false
            });
        }

        // Utility Commands
        if (category === 'all' || category === 'utility') {
            embed.addFields({
                name: '🔧 Utility',
                value:
                    '**`/ping`** - Check bot latency (Verified Raider+)\n' +
                    '**`/help`** - View command information (Organizer+)\n',
                inline: false
            });
        }

        // Add footer with usage tip
        embed.setFooter({ 
            text: 'Tip: Use /help category:<name> to filter commands by category' 
        });

        // Add description based on category
        if (category === 'all') {
            embed.setDescription(
                'Welcome to the ROTMG Raid Bot! Below are all available commands organized by category.\n\n' +
                '**Role Hierarchy:**\n' +
                '• Administrator → Moderator → Officer → Head Organizer → Security → Organizer → Verified Raider\n' +
                '• Commands marked with "+" (e.g., Security+) can be used by that role and all higher roles\n\n' +
                'Use the category filter to view specific command groups.'
            );
        } else {
            const categoryNames: Record<string, string> = {
                raids: 'Raid Management',
                moderation: 'Moderation',
                config: 'Configuration',
                stats: 'Statistics',
                utility: 'Utility'
            };
            embed.setDescription(
                `Showing commands for **${categoryNames[category]}** category.\n\n` +
                'Use `/help` without a category to view all commands.'
            );
        }

        await interaction.reply({
            embeds: [embed]
        });
    },
};
