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

interface CommandHelp {
    name: string;
    description: string;
    usage: string;
    examples?: string[];
}

const commandHelpMap: Record<string, CommandHelp> = {
    run: {
        name: 'run',
        description: 'Create a run in the configured raid channel. Choose one dungeon directly or omit it to select up to five compatible dungeons.',
        usage: '/run [dungeon:<name>] [party:<name>] [location:<server>] [description:<text>]',
        examples: ['/run dungeon:Void', '/run - Open the multi-dungeon selector'],
    },
    taken: {
        name: 'taken',
        description: 'Submit the required taken screenshot for your active Oryx 3 before moving it to Live.',
        usage: '/taken screenshot:<file>',
    },
    headcount: {
        name: 'headcount',
        description: 'Create a headcount for up to five dungeons with per-dungeon interest and key-offer buttons.',
        usage: '/headcount',
    },
    party: {
        name: 'party',
        description: 'Create a party finder post with an optional location and up to five dungeons.',
        usage: '/party party_name:<name> description:<description> [location:<server>] [dungeon_1:<dungeon>] [dungeon_2:<dungeon>] [dungeon_3:<dungeon>] [dungeon_4:<dungeon>] [dungeon_5:<dungeon>]',
    },
    logrun: {
        name: 'logrun',
        description: 'Manually add or remove run activity and its configured quota credit for an organizer.',
        usage: '/logrun dungeon:<name> [amount:<number>] [member:<user>]',
    },
    logkey: {
        name: 'logkey',
        description: 'Manually add or remove key pops for a raider and apply configured key-pop points.',
        usage: '/logkey member:<user> dungeon:<name> [amount:<number>]',
    },
    logminutes: {
        name: 'logminutes',
        description: 'Recover minute-based quota credit for one of your eligible ended runs when the original prompt was missed.',
        usage: '/logminutes run:<run reference> minutes:<number>',
        examples: ['/logminutes run:123 minutes:45'],
    },
    verify: {
        name: 'verify',
        description: 'Manually verify a member with their ROTMG IGN, assign the Verified Raider role, and update their nickname.',
        usage: '/verify member:<user> ign:<name>',
    },
    unverify: {
        name: 'unverify',
        description: 'Remove a member from the verification system and remove their Verified Raider role.',
        usage: '/unverify member:<user> [reason:<text>]',
    },
    editname: {
        name: 'editname',
        description: 'Update a verified raider\'s main IGN and Discord nickname.',
        usage: '/editname member:<user> ign:<name>',
    },
    addalt: {
        name: 'addalt',
        description: 'Add an alternate IGN to a verified member.',
        usage: '/addalt member:<user> ign:<name>',
    },
    removealt: {
        name: 'removealt',
        description: 'Remove the alternate IGN from a verified member.',
        usage: '/removealt member:<user>',
    },
    warn: {
        name: 'warn',
        description: 'Issue and record a warning for a member.',
        usage: '/warn member:<user> reason:<text>',
    },
    suspend: {
        name: 'suspend',
        description: 'Temporarily suspend a member from raids.',
        usage: '/suspend member:<user> duration:<time> reason:<text>',
    },
    unsuspend: {
        name: 'unsuspend',
        description: 'Remove an active raid suspension early.',
        usage: '/unsuspend member:<user> reason:<text>',
    },
    mute: {
        name: 'mute',
        description: 'Temporarily prevent a member from sending messages.',
        usage: '/mute member:<user> duration:<time> reason:<text>',
    },
    unmute: {
        name: 'unmute',
        description: 'Remove an active mute early.',
        usage: '/unmute member:<user> reason:<text>',
    },
    find: {
        name: 'find',
        description: 'View a member\'s verification, alternate IGN, punishments, and staff notes.',
        usage: '/find member:<user> [active_only:<true|false>]',
    },
    removepunishment: {
        name: 'removepunishment',
        description: 'Remove a punishment or staff note by the record ID shown in /find.',
        usage: '/removepunishment id:<record ID> reason:<text>',
    },
    addnote: {
        name: 'addnote',
        description: 'Add a staff note to a member\'s record.',
        usage: '/addnote member:<user> note:<text>',
    },
    kick: {
        name: 'kick',
        description: 'Remove a member from the server without banning them.',
        usage: '/kick member:<user> reason:<text>',
    },
    ban: {
        name: 'ban',
        description: 'Ban a member from the server.',
        usage: '/ban member:<user> reason:<text>',
    },
    unban: {
        name: 'unban',
        description: 'Remove a ban using the banned user\'s Discord ID.',
        usage: '/unban user_id:<Discord ID> reason:<text>',
    },
    softban: {
        name: 'softban',
        description: 'Ban and immediately unban a member to remove recent messages.',
        usage: '/softban member:<user> reason:<text>',
    },
    addpoints: {
        name: 'addpoints',
        description: 'Manually add or remove raider points for a member.',
        usage: '/addpoints amount:<number> [member:<user>]',
    },
    addquotapoints: {
        name: 'addquotapoints',
        description: 'Manually adjust a member\'s points for a selected quota role.',
        usage: '/addquotapoints amount:<number> quota_role:<role> [member:<user>]',
    },
    addrole: {
        name: 'addrole',
        description: 'Add an allowed lower staff role to a member.',
        usage: '/addrole member:<user> role:<role>',
    },
    modmail: {
        name: 'modmail',
        description: 'Send a private support message to server staff and open a modmail ticket.',
        usage: '/modmail',
    },
    modmailreply: {
        name: 'modmailreply',
        description: 'Reply to the user from inside a modmail ticket thread.',
        usage: '/modmailreply message:<text>',
    },
    modmailblacklist: {
        name: 'modmailblacklist',
        description: 'Prevent a member from opening modmail tickets.',
        usage: '/modmailblacklist member:<user> reason:<text>',
    },
    modmailunblacklist: {
        name: 'modmailunblacklist',
        description: 'Restore a member\'s access to modmail.',
        usage: '/modmailunblacklist member:<user> reason:<text>',
    },
    stats: {
        name: 'stats',
        description: 'View points, quota points, runs organized, non-exalt run time, verifications, keys, and per-dungeon activity.',
        usage: '/stats [member:<user>]',
    },
    leaderboard: {
        name: 'leaderboard',
        description: 'Rank runs organized, keys popped, dungeon completions, raider points, or quota points with dungeon and date filters.',
        usage: '/leaderboard category:<category> dungeon:<dungeon|all> [sort:<order>] [since:<date>] [until:<date>]',
    },
    listrole: {
        name: 'listrole',
        description: 'List up to 250 server members who have a selected Discord role.',
        usage: '/listrole role:<role>',
    },
    setroles: {
        name: 'setroles',
        description: 'Map Discord roles to bot permissions and managed Team, Verified Raider, Suspended, and Muted roles.',
        usage: '/setroles [administrator:<role>] [moderator:<role>] [head_organizer:<role>] [officer:<role>] [security:<role>] [organizer:<role>] [team:<role>] [verified_raider:<role>] [suspended:<role>] [muted:<role>]',
    },
    setchannels: {
        name: 'setchannels',
        description: 'Configure the channels used for raids, Active Runs, verification, quotas, moderation, modmail, parties, role pings, and logs. Use no options to view current mappings.',
        usage: '/setchannels [raid:<channel>] [active_runs:<channel>] [veri_log:<channel>] [manual_verification:<channel>] [getverified:<channel>] [punishment_log:<channel>] [raid_log:<channel>] [quota:<channel>] [quota_log:<channel>] [bot_log:<channel>] [staff_updates:<channel>] [modmail:<channel>] [role_ping:<channel>] [party_finder:<channel>] [early_loc:<channel>] [bot_bait:<channel>]',
    },
    configquota: {
        name: 'configquota',
        description: 'Configure quota periods, rollover, point sources, dungeon overrides, and the leaderboard panel for one Discord role.',
        usage: '/configquota role:<role>',
    },
    configpoints: {
        name: 'configpoints',
        description: 'Configure raider completion points and key-pop points by dungeon.',
        usage: '/configpoints',
    },
    configverification: {
        name: 'configverification',
        description: 'Post the verification panel or customize its message and RealmEye or manual screenshot instructions.',
        usage: '/configverification <send-panel|set-panel-message|set-manual-instructions|set-realmeye-instructions> [options]',
    },
    configrolepings: {
        name: 'configrolepings',
        description: 'Assign the role ping used when a dungeon appears in a run or headcount. Omit the role to remove it.',
        usage: '/configrolepings dungeon:<name> [role:<role>]',
    },
    setdungeonimage: {
        name: 'setdungeonimage',
        description: 'Set the PNG, JPEG, or WebP image posted after eligible single-dungeon raid panels. Maximum size is 8 MiB.',
        usage: '/setdungeonimage dungeon:<name> image:<attachment>',
    },
    createrole: {
        name: 'createrole',
        description: 'Create a custom screenshot-review panel that grants a selected Discord role after staff approval.',
        usage: '/createrole role:<role> role_channel:<channel> verification_channel:<channel> instructions:<text> [role_description:<text>] [example_screenshot:<file>]',
    },
    sendrolepingembed: {
        name: 'sendrolepingembed',
        description: 'Post the self-service dungeon ping-role panel in the configured role-ping channel.',
        usage: '/sendrolepingembed',
    },
    syncteam: {
        name: 'syncteam',
        description: 'Synchronize the Team role for every member who has a mapped staff role.',
        usage: '/syncteam',
    },
    forcesync: {
        name: 'forcesync',
        description: 'Import or update verified member records from the nicknames of members with Verified Raider or Suspended roles.',
        usage: '/forcesync',
    },
    purge: {
        name: 'purge',
        description: 'Delete up to 25 recent messages in the current channel.',
        usage: '/purge amount:<number>',
    },
    ping: {
        name: 'ping',
        description: 'Check the bot and backend response latency.',
        usage: '/ping',
    },
    help: {
        name: 'help',
        description: 'List commands by permission or show concise help for one command.',
        usage: '/help [command:<name>]',
    },
};

const discordAdministratorCommands = new Set([
    'setroles',
    'setchannels',
    'sendrolepingembed',
    'createrole',
]);

function getCommandHelp(commandName: string): CommandHelp | null {
    return commandHelpMap[commandName] ?? null;
}

function getRoleDisplayName(role: RoleKey): string {
    const roleNames: Record<RoleKey, string> = {
        administrator: 'Administrator',
        moderator: 'Moderator',
        head_organizer: 'Head Organizer',
        officer: 'Officer',
        security: 'Security',
        organizer: 'Organizer',
        verified_raider: 'Verified Raider',
    };
    return roleNames[role];
}

function getCommandAccess(commandName: string): string {
    const command = commands.find(candidate => candidate.data.name === commandName);
    if (command?.requiredRole) {
        const roles = Array.isArray(command.requiredRole) ? command.requiredRole : [command.requiredRole];
        return `${roles.map(getRoleDisplayName).join(' or ')}+`;
    }
    if (discordAdministratorCommands.has(commandName)) return 'Discord Administrator';
    if (commandName === 'logminutes') return 'Original organizer only';
    if (commandName === 'modmail') return 'Everyone';
    return 'No mapped role required';
}

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
    return order[role];
}

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
        const commandNames = commands
            .map(command => command.data.name)
            .filter(name => name.toLowerCase().includes(focusedValue))
            .sort()
            .slice(0, 25);

        await interaction.respond(commandNames.map(name => ({ name, value: name })));
    },

    async run(interaction: ChatInputCommandInteraction) {
        const commandName = interaction.options.getString('command');

        if (commandName) {
            const helpInfo = getCommandHelp(commandName);
            if (!helpInfo) {
                await interaction.reply({
                    content: `No help available for: \`${commandName}\``,
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(`Command: /${helpInfo.name}`)
                .setDescription(helpInfo.description)
                .addFields(
                    { name: 'Usage', value: `\`${helpInfo.usage}\``, inline: false },
                    { name: 'Access', value: getCommandAccess(commandName), inline: true }
                )
                .setColor(0x5865F2)
                .setTimestamp();

            if (helpInfo.examples?.length) {
                embed.addFields({
                    name: 'Examples',
                    value: helpInfo.examples.map(example => `• \`${example}\``).join('\n'),
                    inline: false,
                });
            }

            await interaction.reply({ embeds: [embed] });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('Available Commands')
            .setDescription(
                'Commands are grouped by minimum access. Use `/help command:<name>` for details.\n\n' +
                '**Role Hierarchy:** Administrator > Moderator > Head Organizer > Officer > Security > Organizer > Verified Raider\n\n' +
                'Run and headcount panels support multiple dungeons and key quantities. Oryx 3 organizers use `/taken` before going Live.'
            )
            .setColor(0x5865F2)
            .setFooter({ text: 'A + means the role and all higher mapped roles can use the command' })
            .setTimestamp();

        embed.addFields(
            { name: 'Everyone', value: '`/modmail`', inline: false },
            { name: 'Original organizer only', value: '`/logminutes`', inline: false },
            {
                name: 'Discord Administrator',
                value: [...discordAdministratorCommands].sort().map(name => `\`/${name}\``).join(', '),
                inline: false,
            }
        );

        const commandsByRole = new Map<RoleKey, string[]>();
        for (const command of commands) {
            if (!command.requiredRole) continue;
            const roles = Array.isArray(command.requiredRole) ? command.requiredRole : [command.requiredRole];
            const role = roles[0];
            const roleCommands = commandsByRole.get(role) ?? [];
            roleCommands.push(command.data.name);
            commandsByRole.set(role, roleCommands);
        }

        const sortedRoles = [...commandsByRole.keys()].sort((a, b) => getRoleOrder(a) - getRoleOrder(b));
        for (const role of sortedRoles) {
            const commandNames = commandsByRole.get(role) ?? [];
            embed.addFields({
                name: `${getRoleDisplayName(role)}+`,
                value: commandNames.sort().map(name => `\`/${name}\``).join(', '),
                inline: false,
            });
        }

        await interaction.reply({ embeds: [embed] });
    },
};
