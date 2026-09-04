import {
    AutocompleteInteraction,
    ChatInputCommandInteraction,
    MessageFlags,
    SlashCommandBuilder,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { dungeonByCode, searchDungeons } from '../../constants/dungeons/dungeon-helpers.js';
import { getMemberRoleIds } from '../../lib/permissions/permissions.js';
import { BackendError, setDungeonImage } from '../../lib/utilities/http.js';
import { downloadDungeonImage, DungeonImageValidationError } from '../../lib/utilities/dungeon-image.js';

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
            await setDungeonImage(interaction.guildId, dungeonKey, {
                actor_user_id: interaction.user.id,
                actor_roles: getMemberRoleIds(member),
                actor_has_admin_permission: member.permissions.has('Administrator'),
                image_base64: upload.data.toString('base64'),
                content_type: upload.contentType,
                filename: upload.filename,
            });
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
