import {
    AutocompleteInteraction,
    ChatInputCommandInteraction,
    MessageFlags,
    SlashCommandBuilder,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { dungeonByCode, searchDungeons } from '../../constants/dungeons/dungeon-helpers.js';
import { getMemberRoleIds } from '../../lib/permissions/permissions.js';
import {
    BackendError,
    type DungeonImageMetadata,
    setDungeonImage,
} from '../../lib/utilities/http.js';
import { downloadDungeonImage, DungeonImageValidationError } from '../../lib/utilities/dungeon-image.js';
import { logBotEvent } from '../../lib/logging/bot-logger.js';
import { createLogger } from '../../lib/logging/logger.js';

const logger = createLogger('SetDungeonImage');

function formatImageMetadata(image: DungeonImageMetadata): string {
    return [
        `Filename: \`${image.filename.replaceAll('`', '\u02cb')}\``,
        `Type: \`${image.content_type}\``,
        `Size: \`${image.size_bytes.toLocaleString('en-US')} bytes\``,
    ].join('\n');
}

export const setdungeonimage: SlashCommand = {
    requiredRole: 'moderator',
    data: new SlashCommandBuilder()
        .setName('setdungeonimage')
        .setDescription('Set the raid image for a dungeon (Moderator+)')
        .addStringOption(option => option
            .setName('dungeon')
            .setDescription('Choose a dungeon')
            .setRequired(true)
            .setAutocomplete(true))
        .addAttachmentOption(option => option
            .setName('image')
            .setDescription('PNG, JPEG, or WebP image (maximum 8 MiB)')
            .setRequired(true))
        .setDMPermission(false),

    async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
        const query = interaction.options.getFocused().trim();
        await interaction.respond(searchDungeons(query, 25)
            .filter(dungeon => dungeon.codeName !== 'REALM_DUNGEON')
            .map(dungeon => ({ name: dungeon.dungeonName, value: dungeon.codeName })));
    },

    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        if (!interaction.inGuild() || !interaction.guild || !interaction.guildId) {
            await interaction.reply({
                content: 'This command can only be used in a server.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const dungeonKey = interaction.options.getString('dungeon', true);
        const dungeon = dungeonByCode[dungeonKey];
        if (!dungeon || dungeonKey === 'REALM_DUNGEON') {
            await interaction.editReply('Invalid dungeon selected.');
            return;
        }

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) {
            await interaction.editReply('Could not fetch your member information.');
            return;
        }

        try {
            const upload = await downloadDungeonImage(interaction.options.getAttachment('image', true));
            const update = await setDungeonImage(interaction.guildId, dungeonKey, {
                actor_user_id: interaction.user.id,
                actor_roles: getMemberRoleIds(member),
                actor_has_admin_permission: member.permissions.has('Administrator'),
                image_base64: upload.data.toString('base64'),
                content_type: upload.contentType,
                filename: upload.filename,
            });

            const change = update.previousImage ? 'Replaced' : 'Set';
            const newImage: DungeonImageMetadata = {
                content_type: update.image.content_type,
                filename: update.image.filename,
                size_bytes: upload.data.length,
                updated_at: update.image.updated_at,
            };
            const auditImageFilename = `dungeon-image.${
                update.image.content_type === 'image/jpeg'
                    ? 'jpg'
                    : update.image.content_type.slice('image/'.length)
            }`;
            try {
                await logBotEvent(
                    interaction.client,
                    interaction.guildId,
                    `⚙️ Dungeon Image ${change}`,
                    `A dungeon raid image was ${change.toLowerCase()} with \`/setdungeonimage\`.`,
                    {
                        auditAction: '/setdungeonimage',
                        color: 0x5865F2,
                        files: [{ attachment: upload.data, name: auditImageFilename }],
                        imageUrl: `attachment://${auditImageFilename}`,
                        fields: [
                            { name: 'Command', value: '`/setdungeonimage`', inline: true },
                            { name: 'Change', value: change, inline: true },
                            { name: 'Dungeon', value: dungeon.dungeonName, inline: false },
                            {
                                name: 'Changed By',
                                value: `<@${interaction.user.id}> (${interaction.user.username}, \`${interaction.user.id}\`)`,
                                inline: false,
                            },
                            {
                                name: 'Previous Image',
                                value: update.previousImage
                                    ? formatImageMetadata(update.previousImage)
                                    : 'None / Not set',
                                inline: false,
                            },
                            { name: 'New Image', value: formatImageMetadata(newImage), inline: false },
                        ],
                    }
                );
            } catch (logError) {
                // The shared bot logger normally absorbs delivery errors. Keep this
                // guard so an audit failure can never turn a persisted update into
                // a false command failure.
                logger.error('Failed to emit dungeon image bot-log audit', {
                    error: logError,
                    guildId: interaction.guildId,
                    dungeonKey,
                    actorId: interaction.user.id,
                });
            }
            await interaction.editReply(`Dungeon image set for ${dungeon.dungeonName}.`);
        } catch (error) {
            if (error instanceof DungeonImageValidationError) {
                await interaction.editReply(error.message);
                return;
            }
            const message = error instanceof BackendError && error.code === 'NOT_AUTHORIZED'
                ? 'You need the Moderator role or higher to use this command.'
                : 'Failed to set the dungeon image.';
            await interaction.editReply(message);
        }
    },
};
