// bot/src/commands/help.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    EmbedBuilder,
    MessageFlags,
} from 'discord.js';
import type { SlashCommand } from './_types.js';
import type { RoleKey } from '../lib/permissions/permissions.js';
import { commands } from './index.js';

/**
 * Command metadata for detailed help information
 */
interface CommandHelp {
    name: string;
    description: string;
    usage: string;
    examples?: string[];
}

/**
 * Get detailed help information for a specific command
 */
function getCommandHelp(commandName: string): CommandHelp | null {
    const commandHelpMap: Record<string, CommandHelp> = {
        run: {
            name: 'run',
            description: 'Create a new raid run in the current channel. This posts a fully interactive raid panel with reactions for class selection and controls for the run leader.',
            usage: '/run dungeon:<name> [party:<name>] [location:<server>] [description:<text>]',
            examples: [
                '/run dungeon:Void - Create a Void run',
                '/run dungeon:Lost Halls party:Vanguard location:USW3 - Create a Lost Halls run with party name and location',
            ],
        },
        headcount: {
            name: 'headcount',
            description: 'Create a lightweight headcount panel to gauge interest for upcoming runs without creating a full raid.',
            usage: '/headcount',
            examples: ['/headcount - Opens a modal to create a headcount'],
        },
        logrun: {
            name: 'logrun',
            description: 'Manually adjust run completion quota points for an organizer. Use positive numbers to add runs, negative to remove.',
            usage: '/logrun dungeon:<name> [amount:<number>] [member:<user>]',
            examples: [
                '/logrun dungeon:Void amount:1 - Add 1 Void run to your quota',
                '/logrun dungeon:Lost Halls amount:-1 member:@User - Remove 1 LH run from another organizer',
            ],
        },
        logkey: {
            name: 'logkey',
            description: 'Manually log key pops for a raider. This awards key pop points if configured.',
            usage: '/logkey member:<user> dungeon:<name> [amount:<number>]',
            examples: [
                '/logkey member:@User dungeon:Void - Log 1 Void key for a raider',
                '/logkey member:@User dungeon:Lost Halls amount:3 - Log 3 LH keys',
            ],
        },
        verify: {
            name: 'verify',
            description: 'Manually verify a member with their ROTMG in-game name. Assigns the Verified Raider role and tracks the IGN in the database.',
            usage: '/verify member:<user> ign:<name>',
            examples: ['/verify member:@User ign:PlayerName - Verify a member'],
        },
        unverify: {
            name: 'unverify',
            description: 'Remove verification status from a member. Removes the Verified Raider role and updates database status.',
            usage: '/unverify member:<user> [reason:<text>]',
            examples: ['/unverify member:@User reason:Left guild - Unverify a member'],
        },
        editname: {
            name: 'editname',
            description: 'Update a verified raider\'s IGN and automatically update their Discord nickname to match.',
            usage: '/editname member:<user> ign:<name>',
            examples: ['/editname member:@User ign:NewName - Update IGN'],
        },
        addalt: {
            name: 'addalt',
            description: 'Add an alternate IGN to a verified member\'s account.',
            usage: '/addalt member:<user> ign:<name>',
            examples: ['/addalt member:@User ign:AltName - Add an alt IGN'],
        },
        removealt: {
            name: 'removealt',
            description: 'Remove the alternate IGN from a verified member\'s account.',
            usage: '/removealt member:<user>',
            examples: ['/removealt member:@User - Remove alt IGN'],
        },
        warn: {
            name: 'warn',
            description: 'Issue a formal warning to a member. Recorded in punishment history and can stack towards further actions.',
            usage: '/warn member:<user> reason:<text>',
            examples: ['/warn member:@User reason:Disrupting raids - Issue a warning'],
        },
        suspend: {
            name: 'suspend',
            description: 'Temporarily suspend a member from participating in raids. Assigns the Suspended role for the specified duration.',
            usage: '/suspend member:<user> duration:<time> reason:<text>',
            examples: [
                '/suspend member:@User duration:5h reason:AFK in run - 5 hour suspension',
                '/suspend member:@User duration:2d reason:Multiple infractions - 2 day suspension',
            ],
        },
        unsuspend: {
            name: 'unsuspend',
            description: 'Remove an active suspension from a member early.',
            usage: '/unsuspend member:<user> reason:<text>',
            examples: ['/unsuspend member:@User reason:Appeal approved - Remove suspension'],
        },
        mute: {
            name: 'mute',
            description: 'Temporarily prevent a member from sending messages. Assigns the Muted role for the specified duration.',
            usage: '/mute member:<user> duration:<time> reason:<text>',
            examples: [
                '/mute member:@User duration:30m reason:Spam - 30 minute mute',
                '/mute member:@User duration:5h reason:Harassment - 5 hour mute',
            ],
        },
        unmute: {
            name: 'unmute',
            description: 'Remove an active mute from a member early.',
            usage: '/unmute member:<user> reason:<text>',
            examples: ['/unmute member:@User reason:Appealed - Remove mute'],
        },
        checkpunishments: {
            name: 'checkpunishments',
            description: 'View complete punishment history for a member, including warnings, suspensions, and notes.',
            usage: '/checkpunishments member:<user> [active_only:<true/false>]',
            examples: [
                '/checkpunishments member:@User - View all punishments',
                '/checkpunishments member:@User active_only:true - View only active punishments',
            ],
        },
        removepunishment: {
            name: 'removepunishment',
            description: 'Remove a punishment or note from records by ID. Get IDs from /checkpunishments.',
            usage: '/removepunishment id:<punishment_id> reason:<text>',
            examples: ['/removepunishment id:abc123... reason:Issued in error - Remove a punishment'],
        },
        addnote: {
            name: 'addnote',
            description: 'Add a staff note to a member\'s record. Visible only to staff in punishment history.',
            usage: '/addnote member:<user> note:<text>',
            examples: ['/addnote member:@User note:Applied for Trial RL - Add a note'],
        },
        kick: {
            name: 'kick',
            description: 'Remove a member from the server. They can rejoin with a new invite.',
            usage: '/kick member:<user> reason:<text>',
            examples: ['/kick member:@User reason:Rule violation - Kick a member'],
        },
        ban: {
            name: 'ban',
            description: 'Permanently ban a member from the server. They cannot rejoin unless unbanned.',
            usage: '/ban member:<user> reason:<text>',
            examples: ['/ban member:@User reason:Severe rule violation - Ban a member'],
        },
        unban: {
            name: 'unban',
            description: 'Remove a ban from a user, allowing them to rejoin the server.',
            usage: '/unban user_id:<discord_id> reason:<text>',
            examples: ['/unban user_id:123456789 reason:Appeal approved - Unban a user'],
        },
        softban: {
            name: 'softban',
            description: 'Ban then immediately unban a member to delete their recent messages (last 7 days).',
            usage: '/softban member:<user> reason:<text>',
            examples: ['/softban member:@User reason:Spam cleanup - Soft-ban a member'],
        },
        addpoints: {
            name: 'addpoints',
            description: 'Manually adjust raider points for a member. Use for corrections or special awards.',
            usage: '/addpoints amount:<number> [member:<user>]',
            examples: [
                '/addpoints amount:50 member:@User - Add 50 points',
                '/addpoints amount:-25 member:@User - Remove 25 points',
            ],
        },
        addquotapoints: {
            name: 'addquotapoints',
            description: 'Manually adjust quota points for a member. Use for corrections or special circumstances.',
            usage: '/addquotapoints amount:<number> [member:<user>]',
            examples: [
                '/addquotapoints amount:5 member:@User - Add 5 quota points',
                '/addquotapoints amount:-2 member:@User - Remove 2 quota points',
            ],
        },
        addrole: {
            name: 'addrole',
            description: 'Add a staff role to promote a member. Automatically assigns Team role as well.',
            usage: '/addrole member:<user> role:<role>',
            examples: ['/addrole member:@User role:@Organizer - Promote to Organizer'],
        },
        modmail: {
            name: 'modmail',
            description: 'Send a private message to server staff. Creates a thread for staff to respond.',
            usage: '/modmail',
            examples: ['/modmail - Opens modal to send a modmail'],
        },
        modmailreply: {
            name: 'modmailreply',
            description: 'Reply to a modmail ticket. Must be used within the modmail thread.',
            usage: '/modmailreply message:<text>',
            examples: ['/modmailreply message:Thanks for reaching out! - Reply to modmail'],
        },
        modmailblacklist: {
            name: 'modmailblacklist',
            description: 'Prevent a user from using the modmail system.',
            usage: '/modmailblacklist member:<user> reason:<text>',
            examples: ['/modmailblacklist member:@User reason:Abuse of system - Blacklist user'],
        },
        modmailunblacklist: {
            name: 'modmailunblacklist',
            description: 'Remove modmail blacklist from a user.',
            usage: '/modmailunblacklist member:<user> reason:<text>',
            examples: ['/modmailunblacklist member:@User reason:Restriction lifted - Unblacklist user'],
        },
        stats: {
            name: 'stats',
            description: 'View detailed quota statistics including runs completed, keys popped, and points earned.',
            usage: '/stats [member:<user>]',
            examples: [
                '/stats - View your own statistics',
                '/stats member:@User - View another member\'s statistics',
            ],
        },
        leaderboard: {
            name: 'leaderboard',
            description: 'View server leaderboards for various activities and statistics.',
            usage: '/leaderboard',
            examples: ['/leaderboard - Opens leaderboard selector'],
        },
        setroles: {
            name: 'setroles',
            description: 'Configure internal role mappings for the permission system. Map Discord roles to bot permission levels.',
            usage: '/setroles [administrator:<role>] [moderator:<role>] [officer:<role>] [security:<role>] [organizer:<role>] [verified_raider:<role>] [suspended:<role>] [muted:<role>] [team:<role>] [head_organizer:<role>]',
            examples: [
                '/setroles organizer:@Raid Leader verified_raider:@Raider - Set role mappings',
                '/setroles - View current role mappings',
            ],
        },
        setchannels: {
            name: 'setchannels',
            description: 'Configure channel mappings for bot functionality like verification logs and announcements.',
            usage: '/setchannels [verification:<channel>] [quota:<channel>] [bot_log:<channel>] [staff_updates:<channel>]',
            examples: [
                '/setchannels verification:#verify-logs - Set verification log channel',
                '/setchannels - View current channel mappings',
            ],
        },
        configquota: {
            name: 'configquota',
            description: 'Configure quota requirements and settings for the server.',
            usage: '/configquota',
            examples: ['/configquota - Opens quota configuration interface'],
        },
        configpoints: {
            name: 'configpoints',
            description: 'Configure raider points rewards for various activities.',
            usage: '/configpoints',
            examples: ['/configpoints - Opens points configuration interface'],
        },
        configverification: {
            name: 'configverification',
            description: 'Configure verification system settings and requirements.',
            usage: '/configverification',
            examples: ['/configverification - Opens verification config interface'],
        },
        configrolepings: {
            name: 'configrolepings',
            description: 'Configure which roles get pinged for specific dungeon types.',
            usage: '/configrolepings',
            examples: ['/configrolepings - Opens role ping configuration'],
        },
        syncteam: {
            name: 'syncteam',
            description: 'Sync the Team role for all members with staff roles. Ensures Team role is assigned to all staff.',
            usage: '/syncteam',
            examples: ['/syncteam - Sync Team role to all staff'],
        },
        purge: {
            name: 'purge',
            description: 'Bulk delete messages in the current channel.',
            usage: '/purge amount:<number>',
            examples: ['/purge amount:25 - Delete last 25 messages'],
        },
        ping: {
            name: 'ping',
            description: 'Check the bot\'s response time and API latency.',
            usage: '/ping',
            examples: ['/ping - Check bot latency'],
        },
        help: {
            name: 'help',
            description: 'View command information. Use without a command to see all commands grouped by role, or specify a command for detailed help.',
            usage: '/help [command:<name>]',
            examples: [
                '/help - View all commands grouped by role',
                '/help command:run - View detailed help for /run command',
            ],
        },
    };

    return commandHelpMap[commandName] ?? null;
}

/**
 * Get the required role for a command
 */
function getCommandRole(commandName: string): RoleKey | RoleKey[] {
    const command = commands.find(c => c.data.name === commandName);
    return command?.requiredRole ?? 'verified_raider';
}

/**
 * Get role display name with hierarchy order
 */
function getRoleDisplayName(role: RoleKey): string {
    const roleNames: Record<RoleKey, string> = {
        administrator: 'Administrator',
        moderator: 'Moderator',
        officer: 'Officer',
        head_organizer: 'Head Organizer',
        security: 'Security',
        organizer: 'Organizer',
        verified_raider: 'Verified Raider',
    };
    return roleNames[role] ?? role;
}

/**
 * Get role hierarchy order (lower number = higher permission)
 */
function getRoleOrder(role: RoleKey): number {
    const order: Record<RoleKey, number> = {
        administrator: 0,
        moderator: 1,
        head_organizer: 2,
        officer: 3,
        security: 4,
        organizer: 5,
        verified_raider: 6,
    };
    return order[role] ?? 99;
}

/**
 * /help - Display command list or detailed command information
 * Organizer+ command
 */
export const help: SlashCommand = {
    requiredRole: 'organizer',
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('View command information (Organizer+)')
        .addStringOption(option =>
            option
                .setName('command')
                .setDescription('Get detailed help for a specific command')
                .setRequired(false)
                .setAutocomplete(true)
        ),

    async autocomplete(interaction: AutocompleteInteraction) {
        const focusedValue = interaction.options.getFocused().toLowerCase();
        
        // Get all command names
        const commandNames = commands
            .map(c => c.data.name)
            .filter(name => name.toLowerCase().includes(focusedValue))
            .sort()
            .slice(0, 25); // Discord limit

        await interaction.respond(
            commandNames.map(name => ({ name, value: name }))
        );
    },

    async run(interaction: ChatInputCommandInteraction) {
        const commandName = interaction.options.getString('command');

        // If a specific command is requested, show detailed help
        if (commandName) {
            const helpInfo = getCommandHelp(commandName);
            
            if (!helpInfo) {
                await interaction.reply({
                    content: `No help available for: \`${commandName}\``,
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const requiredRole = getCommandRole(commandName);
            const roleText = Array.isArray(requiredRole)
                ? requiredRole.map(getRoleDisplayName).join(' or ')
                : getRoleDisplayName(requiredRole);

            const embed = new EmbedBuilder()
                .setTitle(`Command: /${helpInfo.name}`)
                .setDescription(helpInfo.description)
                .addFields(
                    { name: 'Usage', value: `\`${helpInfo.usage}\``, inline: false },
                    { name: 'Required Role', value: roleText + '+', inline: true }
                )
                .setColor(0x5865F2)
                .setTimestamp();

            if (helpInfo.examples && helpInfo.examples.length > 0) {
                embed.addFields({
                    name: 'Examples',
                    value: helpInfo.examples.map(ex => `• \`${ex}\``).join('\n'),
                    inline: false,
                });
            }

            await interaction.reply({
                embeds: [embed],
            });
            return;
        }

        // Otherwise, show command list grouped by role
        const embed = new EmbedBuilder()
            .setTitle('Available Commands')
            .setDescription(
                'Commands listed below are grouped by required role.\n\n' +
                '**Role Hierarchy:** Administrator → Moderator → Officer → Head Organizer → Security → Organizer → Verified Raider\n\n' +
                'Use `/help command:<name>` for detailed info about a specific command.'
            )
            .setColor(0x5865F2)
            .setFooter({ text: 'Commands marked with + can be used by that role and all higher roles' })
            .setTimestamp();

        // Group commands by their minimum required role
        const commandsByRole: Map<RoleKey, string[]> = new Map();
        
        for (const command of commands) {
            const cmdRole = command.requiredRole;
            if (!cmdRole) continue; // Skip commands without role requirements
            
            const role = Array.isArray(cmdRole) ? cmdRole[0] : cmdRole;
            
            if (!commandsByRole.has(role)) {
                commandsByRole.set(role, []);
            }
            commandsByRole.get(role)!.push(command.data.name);
        }

        // Sort roles by hierarchy and add fields
        const sortedRoles = Array.from(commandsByRole.keys()).sort(
            (a, b) => getRoleOrder(a) - getRoleOrder(b)
        );

        for (const role of sortedRoles) {
            const cmdList = commandsByRole.get(role)!.sort();
            const roleDisplay = getRoleDisplayName(role);
            
            embed.addFields({
                name: `${roleDisplay}+`,
                value: cmdList.map(cmd => `\`/${cmd}\``).join(', '),
                inline: false,
            });
        }

        await interaction.reply({
            embeds: [embed],
        });
    },
};
