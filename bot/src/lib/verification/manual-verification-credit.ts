import type { Client, GuildMember } from 'discord.js';
import type { VerificationSession } from './verification.js';
import { getMemberRoleIds } from '../permissions/permissions.js';
import { awardModerationPointsWithUpdate } from '../utilities/http.js';

type ManualVerificationCreditSession = Pick<
    VerificationSession,
    'created_at' | 'guild_id' | 'ticket_message_id' | 'user_id'
>;

export function getManualVerificationCreditSubjectId(session: ManualVerificationCreditSession): string {
    return `manual_verification:${session.user_id}:${session.ticket_message_id ?? session.created_at}`;
}

/**
 * Award the configured verification credit for handling a manual verification.
 * Approval and rejection intentionally share this function and the same `verify` setting.
 */
export async function awardManualVerificationCredit(
    client: Client,
    session: ManualVerificationCreditSession,
    reviewer: GuildMember
): Promise<{ points_awarded: number; roles_awarded?: number; message?: string }> {
    return awardModerationPointsWithUpdate(
        client,
        session.guild_id,
        reviewer.id,
        {
            actor_user_id: reviewer.id,
            actor_roles: getMemberRoleIds(reviewer),
            command_type: 'verify',
            subject_id: getManualVerificationCreditSubjectId(session),
        }
    );
}
