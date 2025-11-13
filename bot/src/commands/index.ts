import { REST, Routes } from 'discord.js';
import type { SlashCommand } from './_types.js';
import { withPermissionCheck } from '../lib/permissions/command-middleware.js';
import { runCreate } from './run.js';
import { verify } from './moderation/verify.js';
import { setroles } from './conifgs/setroles.js';
import { setchannels } from './conifgs/setchannels.js';
import { editname } from './moderation/editname.js';
import { unverify } from './moderation/unverify.js';
import { warn } from './moderation/warn.js';
import { suspend } from './moderation/suspend.js';
import { unsuspend } from './moderation/unsuspend.js';
import { removepunishment } from './moderation/removepunishment.js';
import { checkpunishments } from './moderation/checkpunishments.js';
import { addnote } from './moderation/addnote.js';
import { logrun } from './logrun.js';
import { logkey } from './logkey.js';
import { stats } from './stats.js';
import { syncteam } from './syncteam.js';
import { configquota } from './conifgs/configquota.js';
import { configpoints } from './conifgs/configpoints.js';
import { configverification } from './conifgs/configverification.js';
import { help } from './help.js';
import { ping } from './ping.js';
import { addquotapoints } from './moderation/addquotapoints.js';
import { addpoints } from './moderation/addpoints.js';
import { headcount } from './headcount.js';

// Apply permission middleware to all commands
export const commands: SlashCommand[] = [
    withPermissionCheck(runCreate),
    withPermissionCheck(headcount),
    withPermissionCheck(verify),
    withPermissionCheck(setroles),
    withPermissionCheck(setchannels),
    withPermissionCheck(editname),
    withPermissionCheck(unverify),
    withPermissionCheck(warn),
    withPermissionCheck(suspend),
    withPermissionCheck(unsuspend),
    withPermissionCheck(removepunishment),
    withPermissionCheck(checkpunishments),
    withPermissionCheck(addnote),
    withPermissionCheck(logrun),
    withPermissionCheck(logkey),
    withPermissionCheck(stats),
    withPermissionCheck(syncteam),
    withPermissionCheck(configquota),
    withPermissionCheck(configpoints),
    withPermissionCheck(configverification),
    withPermissionCheck(help),
    withPermissionCheck(ping),
    withPermissionCheck(addquotapoints),
    withPermissionCheck(addpoints),
];

export function toJSON() {
    return commands.map(c => c.data.toJSON());
}


export async function registerAll(rest: REST, appId: string, guildId: string) {
    const body = toJSON();
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
    return body.map(c => c.name);
}
