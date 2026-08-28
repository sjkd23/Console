import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    Role,
    SlashCommandBuilder,
} from 'discord.js';
import type { SlashCommand } from './_types.js';
import { formatErrorMessage } from '../lib/errors/error-handler.js';
import { ensureGuildContext } from '../lib/utilities/interaction-helpers.js';
import { getRoleMembersWithCache } from '../lib/utilities/member-fetching.js';

const MEMBERS_PER_PAGE = 25;
const MAX_DISPLAYED_MEMBERS = 250;
const PAGINATION_TIMEOUT_MS = 600_000;

function createListRoleButtons(
    currentPage: number,
    totalPages: number,
    disabled = false
): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('listrole_first')
            .setEmoji('⏮️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || currentPage === 0),
        new ButtonBuilder()
            .setCustomId('listrole_prev')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled || currentPage === 0),
        new ButtonBuilder()
            .setCustomId('listrole_page')
            .setLabel(`${currentPage + 1} / ${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId('listrole_next')
            .setEmoji('▶️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled || currentPage === totalPages - 1),
        new ButtonBuilder()
            .setCustomId('listrole_last')
            .setEmoji('⏭️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || currentPage === totalPages - 1)
    );
}

async function setupListRolePagination(
    interaction: ChatInputCommandInteraction,
    embeds: EmbedBuilder[]
): Promise<void> {
    let currentPage = 0;
    const totalPages = embeds.length;

    const message = await interaction.editReply({
        embeds: [embeds[currentPage]],
        components: [createListRoleButtons(currentPage, totalPages)],
    });

    const collector = message.createMessageComponentCollector({
        filter: interactionComponent => {
            if (!interactionComponent.customId.startsWith('listrole_')) {
                return false;
            }

            if (interactionComponent.user.id !== interaction.user.id) {
                interactionComponent.reply({
                    content: 'You can\'t use these buttons. Run `/listrole` to create your own result.',
                    flags: MessageFlags.Ephemeral,
                }).catch(() => {});
                return false;
            }

            return true;
        },
        time: PAGINATION_TIMEOUT_MS,
    });

    collector.on('collect', async (buttonInteraction: ButtonInteraction) => {
        switch (buttonInteraction.customId) {
            case 'listrole_first':
                currentPage = 0;
                break;
            case 'listrole_prev':
                currentPage = Math.max(0, currentPage - 1);
                break;
            case 'listrole_next':
                currentPage = Math.min(totalPages - 1, currentPage + 1);
                break;
            case 'listrole_last':
                currentPage = totalPages - 1;
                break;
            default:
                await buttonInteraction.deferUpdate();
                return;
        }

        await buttonInteraction.update({
            embeds: [embeds[currentPage]],
            components: [createListRoleButtons(currentPage, totalPages)],
        });
    });

    collector.on('end', async () => {
        try {
            await interaction.editReply({
                components: [createListRoleButtons(currentPage, totalPages, true)],
            });
        } catch (err) {
            console.warn('[ListRole] Failed to disable pagination buttons:', err);
        }
    });
}

function buildListRoleEmbeds(
    role: Role,
    memberIds: string[],
    dataMayBeIncomplete: boolean,
    requestedBy: string
): EmbedBuilder[] {
    const displayedMemberIds = memberIds.slice(0, MAX_DISPLAYED_MEMBERS);
    const wasTruncated = memberIds.length > MAX_DISPLAYED_MEMBERS;
    const totalPages = Math.max(1, Math.ceil(displayedMemberIds.length / MEMBERS_PER_PAGE));
    const embeds: EmbedBuilder[] = [];

    for (let page = 0; page < totalPages; page++) {
        const start = page * MEMBERS_PER_PAGE;
        const pageMemberIds = displayedMemberIds.slice(start, start + MEMBERS_PER_PAGE);
        const summaryLines = [
            `**Role:** ${role}`,
            dataMayBeIncomplete
                ? `**Members found in available data:** ${memberIds.length}`
                : `**Member count:** ${memberIds.length}`,
        ];

        if (wasTruncated) {
            summaryLines.push(`**Showing first ${MAX_DISPLAYED_MEMBERS} members.**`);
        }

        if (dataMayBeIncomplete) {
            summaryLines.push('⚠️ Discord member data could not be fully refreshed, so this list and count may be incomplete.');
        }

        const memberList = pageMemberIds.length > 0
            ? pageMemberIds.map(memberId => `<@${memberId}>`).join('\n')
            : dataMayBeIncomplete
                ? 'No members were found in the available member data.'
                : 'No members currently have this role.';

        embeds.push(
            new EmbedBuilder()
                .setTitle(`Members with ${role.name}`)
                .setDescription(`${summaryLines.join('\n')}\n\n${memberList}`)
                .setColor(role.color || 0x5865F2)
                .setFooter({
                    text: `Page ${page + 1} of ${totalPages} • Requested by ${requestedBy}`,
                })
                .setTimestamp()
        );
    }

    return embeds;
}

export const listrole: SlashCommand = {
    requiredRole: 'organizer',
    data: new SlashCommandBuilder()
        .setName('listrole')
        .setDescription('List the members who have a Discord role')
        .addRoleOption(option =>
            option
                .setName('role')
                .setDescription('The role whose members should be listed')
                .setRequired(true)
        )
        .setDMPermission(false),

    async run(interaction: ChatInputCommandInteraction) {
        const guild = await ensureGuildContext(interaction);
        if (!guild) return;

        await interaction.deferReply();

        try {
            const selectedRole = interaction.options.getRole('role', true);

            if (selectedRole.id === guild.id) {
                await interaction.editReply({
                    content: 'Please select a role other than `@everyone`.',
                });
                return;
            }

            const role = guild.roles.cache.get(selectedRole.id)
                ?? await guild.roles.fetch(selectedRole.id).catch(() => null);

            if (!role) {
                await interaction.editReply({
                    content: 'That role could not be found. It may have been deleted; please select another role.',
                });
                return;
            }

            const { memberIds, fetchResult } = await getRoleMembersWithCache(role);
            const dataMayBeIncomplete = fetchResult.source === 'timeout-fallback'
                || fetchResult.source === 'backoff-skip';
            const embeds = buildListRoleEmbeds(
                role,
                memberIds,
                dataMayBeIncomplete,
                interaction.user.tag
            );

            if (embeds.length > 1) {
                await setupListRolePagination(interaction, embeds);
            } else {
                await interaction.editReply({ embeds: [embeds[0]] });
            }
        } catch (err) {
            const errorMessage = formatErrorMessage({
                error: err,
                baseMessage: 'Failed to list role members',
            });
            await interaction.editReply(errorMessage);
        }
    },
};
