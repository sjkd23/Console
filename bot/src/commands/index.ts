import { REST, Routes } from 'discord.js';
import type { SlashCommand } from './_types.js';
import { withPermissionCheck } from '../lib/permissions/command-middleware.js';
import { withRateLimit } from '../lib/utilities/rate-limit-middleware.js';
import { runCreate } from './organizer/run.js';
import { taken } from './organizer/taken.js';
import { verify } from './moderation/security/verify.js';
import { setroles } from './conifgs/setroles.js';
import { setchannels } from './conifgs/setchannels.js';
import { sendrolepingembed } from './conifgs/sendrolepingembed.js';
import { editname } from './moderation/security/editname.js';
import { unverify } from './moderation/security/unverify.js';
import { addalt } from './moderation/security/addalt.js';
import { removealt } from './moderation/security/removealt.js';
import { warn } from './moderation/security/warn.js';
import { suspend } from './moderation/security/suspend.js';
import { unsuspend } from './moderation/security/unsuspend.js';
import { removepunishment } from './moderation/security/removepunishment.js';
import { checkpunishments } from './moderation/security/checkpunishments.js';
import { addnote } from './moderation/security/addnote.js';
import { logrun } from './organizer/logrun.js';
import { logkey } from './organizer/logkey.js';
import { stats } from './stats.js';
import { syncteam } from './moderation/moderator/syncteam.js';
import { configquota } from './conifgs/configquota.js';
import { configpoints } from './conifgs/configpoints.js';
import { configverification } from './conifgs/configverification.js';
import { configrolepings } from './conifgs/configrolepings.js';
import { help } from './help.js';
import { ping } from './ping.js';
import { addquotapoints } from './moderation/officer/addquotapoints.js';
import { addpoints } from './moderation/officer/addpoints.js';
import { addrole } from './moderation/officer/addrole.js';
import { kick } from './moderation/officer/kick.js';
import { ban } from './moderation/officer/ban.js';
import { unban } from './moderation/officer/unban.js';
import { softban } from './moderation/officer/softban.js';
import { mute } from './moderation/security/mute.js';
import { unmute } from './moderation/security/unmute.js';
import { headcount } from './organizer/headcount.js';
import { leaderboard } from './leaderboard.js';
import { purge } from './moderation/moderator/purge.js';
import { modmail } from './moderation/security/modmail.js';
import { modmailreply } from './moderation/security/modmailreply.js';
import { modmailblacklist } from './moderation/officer/modmailblacklist.js';
import { modmailunblacklist } from './moderation/officer/modmailunblacklist.js';

/**
 * Helper to apply both permission checks and rate limiting to a command.
 * Order matters: permission check first, then rate limit (no point rate limiting unauthorized users).
 */
const withMiddleware = (cmd: SlashCommand) => withRateLimit(withPermissionCheck(cmd));

// Apply permission middleware and rate limiting to all commands
export const commands: SlashCommand[] = [
    withMiddleware(runCreate),
    withMiddleware(taken),
    withMiddleware(headcount),
    withMiddleware(verify),
    withMiddleware(setroles),
    withMiddleware(setchannels),
    withMiddleware(sendrolepingembed),
    withMiddleware(editname),
    withMiddleware(unverify),
    withMiddleware(addalt),
    withMiddleware(removealt),
    withMiddleware(warn),
    withMiddleware(suspend),
    withMiddleware(unsuspend),
    withMiddleware(removepunishment),
    withMiddleware(checkpunishments),
    withMiddleware(addnote),
    withMiddleware(logrun),
    withMiddleware(logkey),
    withMiddleware(stats),
    withMiddleware(syncteam),
    withMiddleware(configquota),
    withMiddleware(configpoints),
    withMiddleware(configverification),
    withMiddleware(configrolepings),
    withMiddleware(help),
    withMiddleware(ping),
    withMiddleware(addquotapoints),
    withMiddleware(addpoints),
    withMiddleware(addrole),
    withMiddleware(kick),
    withMiddleware(ban),
    withMiddleware(unban),
    withMiddleware(softban),
    withMiddleware(mute),
    withMiddleware(unmute),
    withMiddleware(leaderboard),
    withMiddleware(purge),
    withMiddleware(modmail),
    withMiddleware(modmailreply),
    withMiddleware(modmailblacklist),
    withMiddleware(modmailunblacklist),
];

export function toJSON() {
    return commands.map(c => c.data.toJSON());
}


export async function registerAll(rest: REST, appId: string, guildId: string) {
    const body = toJSON();
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
    return body.map(c => c.name);
}
