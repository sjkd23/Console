import {
    ButtonInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags
} from 'discord.js';
import { getJSON } from '../../../lib/http.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { formatKeyLabel, getDungeonKeyEmoji, getDungeonKeyEmojiIdentifier } from '../../../lib/key-emoji-helpers.js';
import { logButtonClick } from '../../../lib/raid-logger.js';

export async function handleOrganizerPanel(btn: ButtonInteraction, runId: string) {
    // Fetch run status from backend to determine which buttons to show
    const run = await getJSON<{
        status: string;
        dungeonLabel: string;
        dungeonKey: string;
        organizerId: string;
    }>(
        `/runs/${runId}`
    ).catch(() => null);

    if (!run) {
        await btn.reply({
            content: 'Could not fetch run details.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Authorization check using centralized helper
    const accessCheck = await checkOrganizerAccess(btn, run.organizerId);
    if (!accessCheck.allowed) {
        await btn.reply({
            content: accessCheck.errorMessage,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Fetch key reaction users if there are key reactions for this dungeon
    let keyUsers: Record<string, string[]> = {};
    const keyUsersResponse = await getJSON<{ keyUsers: Record<string, string[]> }>(
        `/runs/${runId}/key-reaction-users`
    ).catch(() => ({ keyUsers: {} }));
    keyUsers = keyUsersResponse.keyUsers;

    const firstEmbed = btn.message.embeds?.[0];
    const dungeonTitle = firstEmbed?.title ?? run.dungeonLabel ?? 'Raid';

    const panelEmbed = new EmbedBuilder()
        .setTitle(`Organizer Panel — ${dungeonTitle}`)
        .setTimestamp(new Date());

    // Build description with key reaction users if any
    let description = 'Use the controls below to manage the raid.';

    if (Object.keys(keyUsers).length > 0) {
        description += '\n\n**Key Reacts:**';
        
        // Get the dungeon-specific key emoji (all keys for this dungeon use the same emoji)
        const dungeonKeyEmoji = getDungeonKeyEmoji(run.dungeonKey);
        
        for (const [keyType, userIds] of Object.entries(keyUsers)) {
            const keyLabel = formatKeyLabel(keyType);

            // Create user mentions
            const mentions = userIds.map(id => `<@${id}>`).join(', ');
            description += `\n${dungeonKeyEmoji} **${keyLabel}** (${userIds.length}): ${mentions}`;

        }
    }

    panelEmbed.setDescription(description);

    let controls: ActionRowBuilder<ButtonBuilder>[];

    if (run.status === 'open') {
        // Starting phase: Start, Cancel (row 1) + Set Party, Set Location (row 2)
        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:start:${runId}`)
                .setLabel('Start')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`run:cancel:${runId}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
        );
        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:setparty:${runId}`)
                .setLabel('Set Party')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`run:setlocation:${runId}`)
                .setLabel('Set Location')
                .setStyle(ButtonStyle.Secondary)
        );
        controls = [row1, row2];
    } else if (run.status === 'live') {
        // Live phase: End, Ping Raiders, Update Note, Key popped (row 1) + Set Party, Set Location (row 2)

        // Build the "Key popped" button with the appropriate emoji
        const keyPoppedButton = new ButtonBuilder()
            .setCustomId(`run:keypop:${runId}`)
            .setLabel('Key popped')
            .setStyle(ButtonStyle.Success);

        // Add emoji from the dungeon's first key reaction if available
        const keyEmojiIdentifier = getDungeonKeyEmojiIdentifier(run.dungeonKey);
        if (keyEmojiIdentifier) {
            keyPoppedButton.setEmoji(keyEmojiIdentifier);
        }

        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:end:${runId}`)
                .setLabel('End Run')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`run:ping:${runId}`)
                .setLabel('Ping Raiders')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(true), // Placeholder for future implementation
            new ButtonBuilder()
                .setCustomId(`run:note:${runId}`)
                .setLabel('Update Note')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true), // Placeholder for future implementation
            keyPoppedButton
        );
        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:setparty:${runId}`)
                .setLabel('Set Party')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`run:setlocation:${runId}`)
                .setLabel('Set Location')
                .setStyle(ButtonStyle.Secondary)
        );
        controls = [row1, row2];
    } else {
        // Ended phase: no controls
        await btn.reply({
            content: 'This run has ended.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (btn.deferred || btn.replied) {
        await btn.followUp({ embeds: [panelEmbed], components: controls, flags: MessageFlags.Ephemeral });
    } else {
        await btn.reply({ embeds: [panelEmbed], components: controls, flags: MessageFlags.Ephemeral });
    }

    // Log organizer panel access
    if (btn.guild) {
        try {
            await logButtonClick(
                btn.client,
                {
                    guildId: btn.guild.id,
                    organizerId: run.organizerId,
                    organizerUsername: '',
                    dungeonName: run.dungeonLabel,
                    type: 'run',
                    runId: parseInt(runId)
                },
                btn.user.id,
                'Organizer Panel',
                'run:org'
            );
        } catch (e) {
            console.error('Failed to log organizer panel access:', e);
        }
    }
}
