// bot/src/lib/ui/key-logging-panel.ts
import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} from 'discord.js';

export interface KeyLoggingState {
    runId: number;
    organizerId: string; // Organizer user ID for logging purposes
    dungeonLabel: string;
    enteredCount: number;
    remainingKeys: number;
    runBoundAllowance: boolean;
    loggableDungeons: Array<{ dungeonKey: string; dungeonLabel: string }>;
    selectedDungeonKey: string | null;
    keyReactionUsers: string[]; // User IDs who pressed key buttons
    keyReactionUsersByDungeon: Record<string, string[]>;
    userDisplayNames: Map<string, string>; // Map of userId -> display name
    logs: Array<{
        userId: string;
        username: string;
        amount: number;
        pointsAwarded: number;
        dungeonKey: string;
        dungeonLabel: string;
    }>;
}

/**
 * Build the key logging panel with user selection and key count dropdowns.
 * Shows remaining keys, allows selecting users who pressed buttons, or custom name entry.
 */
export function buildKeyLoggingPanel(
    state: KeyLoggingState
): {
    embed: EmbedBuilder;
    components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
} {
    // Build description with Oryx 3 clarification if applicable
    let description = `The run has ended. Log any actual keys used, or finish early for natural portals.\n\n`;
    
    // Add Oryx 3 specific note
    if (!state.runBoundAllowance) {
        description += `*Note: For logging purposes, runes and incs are counted as keys.*\n\n`;
    }
    
    description += (state.runBoundAllowance
        ? `**Dungeon Entries:** ${state.enteredCount}\n` +
          `**Keys Logged:** ${state.enteredCount - state.remainingKeys}\n` +
          `**Remaining Possible Key Logs:** ${state.remainingKeys}\n\n`
        : `**Total Runes/Incs:** ${state.enteredCount}\n**Remaining to Log:** ${state.remainingKeys}\n\n`) +
        (state.loggableDungeons.length > 1
            ? `**Key Dungeon:** ${state.selectedDungeonKey
                ? state.loggableDungeons.find(dungeon => dungeon.dungeonKey === state.selectedDungeonKey)?.dungeonLabel ?? 'Unknown'
                : 'Select a dungeon below'}\n\n`
            : '') +
        (state.logs.length > 0
            ? `**Log Details:**\n${state.logs
                  .map(
                      (log) =>
                          `• <@${log.userId}> - ${log.amount} ${log.dungeonLabel} key${log.amount > 1 ? 's' : ''} (+${Number(log.pointsAwarded).toFixed(2)} pts)`
                  )
                  .join('\n')}`
            : '⏳ No keys logged yet.');

    const embed = new EmbedBuilder()
        .setTitle(`🔑 Log Keys - ${state.dungeonLabel}`)
        .setDescription(description)
        .setColor(0xfee75c) // Gold color for keys
        .setTimestamp(new Date());

    const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

    // If there are remaining keys, show controls
    if (state.remainingKeys > 0) {
        if (state.loggableDungeons.length > 1) {
            const dungeonMenu = new StringSelectMenuBuilder()
                .setCustomId(`keylog:selectdungeon:${state.runId}`)
                .setPlaceholder('Select the physical key used')
                .addOptions(state.loggableDungeons.map(dungeon =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(dungeon.dungeonLabel)
                        .setValue(dungeon.dungeonKey)
                        .setDefault(dungeon.dungeonKey === state.selectedDungeonKey)
                ));
            components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(dungeonMenu));
        }

        const hasSelectedDungeon = state.selectedDungeonKey !== null;
        const selectedKeyReactionUsers = state.selectedDungeonKey
            ? (state.keyReactionUsersByDungeon[state.selectedDungeonKey] ?? state.keyReactionUsers)
            : [];
        // Row 1: User selection dropdown (only users who pressed key buttons)
        if (hasSelectedDungeon && selectedKeyReactionUsers.length > 0) {
            const userOptions = selectedKeyReactionUsers.slice(0, 25).map((userId) => {
                const displayName = state.userDisplayNames.get(userId) || userId;
                return new StringSelectMenuOptionBuilder()
                    .setLabel(displayName)
                    .setValue(userId)
                    .setDescription('Pressed a key button');
            });

            const userSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`keylog:selectuser:${state.runId}`)
                .setPlaceholder('Select a user who pressed a key button')
                .addOptions(userOptions);

            components.push(
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(userSelectMenu)
            );
        }

        // Row 2: Buttons for custom name and cancel
        const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`keylog:custom:${state.runId}`)
                .setLabel('Custom Name')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('✏️')
                .setDisabled(!hasSelectedDungeon),
            new ButtonBuilder()
                .setCustomId(`keylog:cancel:${state.runId}`)
                .setLabel('Finish Key Logging')
                .setStyle(ButtonStyle.Danger)
        );

        components.push(buttonRow);
    } else {
        // All keys logged, show completion message
        let completionDescription = `✅ All keys have been logged!\n\n`;
        
        // Add Oryx 3 specific note
        if (!state.runBoundAllowance) {
            completionDescription += `*Note: For logging purposes, runes and incs are counted as keys.*\n\n`;
        }
        
        completionDescription += `${state.runBoundAllowance ? '**Dungeon Entries:**' : '**Total Runes/Incs:**'} ${state.enteredCount}\n\n` +
            `**Keys Logged:**\n${state.logs
                .map(
                    (log) =>
                        `• <@${log.userId}> - ${log.amount} ${log.dungeonLabel} key${log.amount > 1 ? 's' : ''} (+${log.pointsAwarded.toFixed(2)} pts)`
                )
                .join('\n')}`;
        
        embed.setDescription(completionDescription);

        // Add close button
        const closeButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`keylog:close:${state.runId}`)
                .setLabel('Close')
                .setStyle(ButtonStyle.Secondary)
        );

        components.push(closeButton);
    }

    return { embed, components };
}

/**
 * Build a key count selection menu (1 to maxKeys).
 * This is shown after a user is selected to ask how many keys they popped.
 */
export function buildKeyCountMenu(
    runId: number,
    userId: string,
    maxKeys: number,
    dungeonLabel: string
): {
    embed: EmbedBuilder;
    components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
} {
    const embed = new EmbedBuilder()
        .setTitle(`🔑 Log Keys - ${dungeonLabel}`)
        .setDescription(
            `How many keys did <@${userId}> pop?\n\n` +
            `Select the number of keys below (1-${maxKeys}).`
        )
        .setColor(0xfee75c)
        .setTimestamp(new Date());

    // Create options for 1 to maxKeys
    const options = [];
    for (let i = 1; i <= Math.min(maxKeys, 25); i++) {
        options.push(
            new StringSelectMenuOptionBuilder()
                .setLabel(`${i} key${i > 1 ? 's' : ''}`)
                .setValue(i.toString())
        );
    }

    const keyCountMenu = new StringSelectMenuBuilder()
        .setCustomId(`keylog:keycount:${runId}:${userId}`)
        .setPlaceholder('Select number of keys')
        .addOptions(options);

    const backButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`keylog:back:${runId}`)
            .setLabel('Back')
            .setStyle(ButtonStyle.Secondary)
    );

    return {
        embed,
        components: [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(keyCountMenu),
            backButton,
        ],
    };
}

/**
 * Build custom name search result feedback.
 * Shows whether the user was found or not.
 */
export function buildCustomNameFeedback(
    runId: number,
    searchQuery: string,
    foundUser: { id: string; username: string } | null,
    dungeonLabel: string
): {
    embed: EmbedBuilder;
    components: ActionRowBuilder<ButtonBuilder>[];
} {
    const embed = new EmbedBuilder()
        .setTitle(`🔑 Log Keys - ${dungeonLabel}`)
        .setColor(0xfee75c)
        .setTimestamp(new Date());

    const components: ActionRowBuilder<ButtonBuilder>[] = [];

    if (foundUser) {
        embed.setDescription(
            `✅ **User Found!**\n\n` +
            `IGN: \`${searchQuery}\`\n` +
            `Found: <@${foundUser.id}> (${foundUser.username})\n\n` +
            `Click "Continue" to log keys for this user, or "Back" to search again.`
        );

        components.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`keylog:selectuser:${runId}:${foundUser.id}`)
                    .setLabel('Continue')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`keylog:back:${runId}`)
                    .setLabel('Back')
                    .setStyle(ButtonStyle.Secondary)
            )
        );
    } else {
        embed.setDescription(
            `❌ **User Not Found**\n\n` +
            `IGN: \`${searchQuery}\`\n\n` +
            `Could not find a Discord user with this IGN.\n` +
            `The IGN must match their Discord username or nickname. Try clicking "Back" and selecting from the dropdown instead.`
        );

        components.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`keylog:back:${runId}`)
                    .setLabel('Back')
                    .setStyle(ButtonStyle.Primary)
            )
        );
    }

    return { embed, components };
}
