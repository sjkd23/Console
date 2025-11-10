import { REST, Routes } from 'discord.js';
import type { SlashCommand } from './_types.js';
import { ping } from './ping.js';
import { info } from './info.js';
import { runCreate } from './run.js';

export const commands: SlashCommand[] = [ping, info, runCreate];

export function toJSON() {
    return commands.map(c => c.data.toJSON());
}


export async function registerAll(rest: REST, appId: string, guildId: string) {
    const body = toJSON();
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
    return body.map(c => c.name);
}
