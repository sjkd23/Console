import { REST, Routes } from 'discord.js';
import type { SlashCommand } from './_types.js';
import { withPermissionCheck } from '../lib/permissions/command-middleware.js';
import { runCreate } from './organizer/run.js';
import { verify } from './moderation/security/verify.js';
import { setroles } from './conifgs/setroles.js';
import { setchannels } from './conifgs/setchannels.js';
import { editname } from './moderation/security/editname.js';
import { unverify } from './moderation/security/unverify.js';
import { warn } from './moderation/security/warn.js';
import { suspend } from './moderation/security/suspend.js';
import { unsuspend } from './moderation/security/unsuspend.js';
import { removepunishment } from './moderation/officer/removepunishment.js';
import { checkpunishments } from './moderation/security/checkpunishments.js';
import { addnote } from './moderation/security/addnote.js';
import { logrun } from './organizer/logrun.js';
import { logkey } from './organizer/logkey.js';
import { stats } from './stats.js';
import { syncteam } from './moderation/moderator/syncteam.js';
import { configquota } from './conifgs/configquota.js';
import { configpoints } from './conifgs/configpoints.js';
import { configverification } from './conifgs/configverification.js';
import { help } from './help.js';
import { ping } from './ping.js';
import { addquotapoints } from './moderation/officer/addquotapoints.js';
import { addpoints } from './moderation/officer/addpoints.js';
import { addrole } from './moderation/officer/addrole.js';
import { headcount } from './organizer/headcount.js';

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
    withPermissionCheck(addrole),
];

export function toJSON() {
    return commands.map(c => c.data.toJSON());
}


export async function registerAll(rest: REST, appId: string, guildId: string) {
    const body = toJSON();
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
    return body.map(c => c.name);
}
