import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    type AutocompleteInteraction,
    MessageFlags,
    type Guild,
    type GuildMember,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { getMemberRoleIds } from '../../lib/permissions/permissions.js';
import { createRun, deleteJSON } from '../../lib/utilities/http.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import type { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';
import { addRecentDungeon } from '../../lib/utilities/dungeon-cache.js';
import { ensureGuildContext, fetchGuildMember } from '../../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../../lib/errors/error-handler.js';
import { handleDungeonAutocomplete } from '../../lib/utilities/dungeon-autocomplete.js';
import { createRunRole, deleteRunRole } from '../../lib/utilities/run-role-manager.js';
import { createLogger } from '../../lib/logging/logger.js';
import { getDefaultAutoEndMinutes } from '../../config/raid-config.js';
import { checkOrganizerActiveActivities } from '../../lib/utilities/organizer-activity-checker.js';
import { fetchConfiguredRaidChannel } from '../../lib/utilities/channel-helpers.js';
import { sendRunOrganizerPanelAsFollowUp } from '../../interactions/buttons/raids/organizer-panel.js';
import {
    buildDungeonSelectionSuccessState,
    collectDungeonSelection,
} from '../../lib/ui/dungeon-selection-panel.js';
import { classifyRunDungeons, type RunKind } from '../../constants/dungeons/dungeon-taxonomy.js';
import { initializePublishedRun, publishCreatedRun } from '../../lib/utilities/run-publication.js';

const logger = createLogger('RunCreate');

export const runCreate: SlashCommand = {
    requiredRole: 'organizer',
    data: new SlashCommandBuilder()
        .setName('run')
        .setDescription('Create a new run (posts to the configured raid channel).')
        .addStringOption(option => option
            .setName('dungeon')
            .setDescription('Choose a dungeon, or omit to select up to five')
            .setRequired(false)
            .setAutocomplete(true))
        .addStringOption(option => option.setName('party').setDescription('Party name (optional)'))
        .addStringOption(option => option.setName('location').setDescription('Location/server (optional)'))
        .addStringOption(option => option.setName('description').setDescription('Run description (optional)')),

    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = await ensureGuildContext(interaction);
        if (!guild) return;
        const member = await fetchGuildMember(guild, interaction.user.id);
        if (!member) {
            await interaction.editReply('Could not fetch your member information.');
            return;
        }

        const activityCheck = await checkOrganizerActiveActivities(interaction, guild.id, interaction.user.id);
        if (activityCheck.errorMessage) {
            await interaction.editReply(activityCheck.errorMessage);
            return;
        }

        const codeName = interaction.options.getString('dungeon');
        const usedSelector = !codeName;
        let selectedDungeons: DungeonInfo[];
        if (codeName) {
            const dungeon = dungeonByCode[codeName];
            if (!dungeon) {
                await interaction.editReply('Unknown dungeon name. Try again.');
                return;
            }
            selectedDungeons = [dungeon];
        } else {
            const selected = await collectDungeonSelection(interaction, {
                namespace: 'run-select',
                title: 'Select dungeons for the run',
                instructions: 'Choose one dungeon, 2–5 exalts, or 2–5 non-exalts. Realm Clearing may accompany non-exalts; Oryx 3 must be alone.',
                confirmLabel: 'Create Run',
                validate: dungeons => {
                    try {
                        classifyRunDungeons(dungeons);
                        return null;
                    } catch (error) {
                        return error instanceof Error ? error.message : 'Invalid dungeon selection.';
                    }
                },
            });
            if (!selected) return;
            selectedDungeons = selected;

            const confirmCheck = await checkOrganizerActiveActivities(interaction, guild.id, interaction.user.id);
            if (confirmCheck.errorMessage) {
                await interaction.editReply({ content: confirmCheck.errorMessage, components: [] });
                return;
            }
        }

        await createRunFromSelection(interaction, guild, member, selectedDungeons, usedSelector);
    },

    async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
        await handleDungeonAutocomplete(interaction);
    },
};

function getRoleLabel(runKind: RunKind, selectedDungeons: readonly DungeonInfo[]): string {
    if (runKind === 'multi_exalt') return 'Multi Exalt';
    if (runKind === 'multi_non_exalt') return 'Multi Dungeon';
    if (runKind === 'realm_clearing') return 'Realm Clearing';
    return selectedDungeons[0].dungeonName;
}

async function createRunFromSelection(
    interaction: ChatInputCommandInteraction,
    guild: Guild,
    member: GuildMember,
    selectedDungeons: DungeonInfo[],
    usedSelector: boolean
): Promise<void> {
    const classification = classifyRunDungeons(selectedDungeons);
    const description = interaction.options.getString('description') || undefined;
    const party = interaction.options.getString('party') || undefined;
    const location = interaction.options.getString('location') || undefined;

    const raidChannel = await fetchConfiguredRaidChannel(guild, interaction);
    if (!raidChannel) return;

    for (const dungeon of selectedDungeons) addRecentDungeon(guild.id, dungeon.codeName);

    const role = await createRunRole(guild, interaction.user.username, getRoleLabel(classification.runKind, selectedDungeons));
    if (!role) {
        await interaction.editReply('**Warning:** Failed to create the run role. The run will still be created, but members will not be automatically assigned a role.');
    }

    let backendRunId: number | null = null;
    let published = false;
    try {
        const created = await createRun({
            guildId: guild.id,
            guildName: guild.name,
            organizerId: interaction.user.id,
            organizerUsername: interaction.user.username,
            organizerRoles: getMemberRoleIds(member),
            channelId: raidChannel.id,
            selectedDungeonKeys: selectedDungeons.map(dungeon => dungeon.codeName),
            description,
            party,
            location,
            autoEndMinutes: getDefaultAutoEndMinutes(),
            roleId: role?.id,
        });
        backendRunId = created.runId;

        const sent = await publishCreatedRun({
            guild,
            raidChannel,
            organizerId: interaction.user.id,
            created,
            description,
            party,
            location,
        });
        published = true;
        await interaction.editReply(usedSelector
            ? buildDungeonSelectionSuccessState(sent.url)
            : `Run created and posted: ${sent.url}`);
        await sendRunOrganizerPanelAsFollowUp(interaction, created.runId, guild.id);

        initializePublishedRun({
            client: interaction.client,
            guild,
            message: sent,
            created,
            organizerId: interaction.user.id,
            organizerUsername: interaction.user.username,
            roleId: role?.id,
            party,
            location,
            description,
        });
    } catch (error) {
        if (backendRunId !== null && !published) {
            await deleteJSON(`/runs/${backendRunId}`, {
                actorId: interaction.user.id,
                actorRoles: getMemberRoleIds(member),
            }, { guildId: guild.id }).catch(rollbackError => {
                logger.error('Failed to cancel an unpublished run during rollback', { runId: backendRunId, rollbackError });
            });
        }
        if (role && !published) await deleteRunRole(guild, role.id);
        const errorMessage = formatErrorMessage({
            error,
            baseMessage: 'Failed to create run',
            errorHandlers: {
                NOT_ORGANIZER: 'You must have the configured Organizer role to create runs.',
            },
        });
        await interaction.editReply(errorMessage);
    }
}
