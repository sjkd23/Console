// src/commands/_types.ts
import type {
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    SlashCommandBuilder,
    SlashCommandSubcommandsOnlyBuilder,
    SlashCommandOptionsOnlyBuilder,
} from 'discord.js';
import type { RoleKey } from '../lib/permissions/permissions.js';

export type SlashCommand = {
    data:
    | SlashCommandBuilder
    | SlashCommandSubcommandsOnlyBuilder
    | SlashCommandOptionsOnlyBuilder;
    run: (interaction: ChatInputCommandInteraction) => Promise<void>;
    autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
    /**
     * Required role(s) to execute this command.
     * If array is provided, user needs at least one of the roles (OR logic).
     */
    requiredRole?: RoleKey | RoleKey[];
    /**
     * Whether this command performs role mutations (add/remove Discord roles).
     * If true, bot role position check will be enforced before execution.
     */
    mutatesRoles?: boolean;
};
