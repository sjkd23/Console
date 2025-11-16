/**
 * Unified error shape for ALL non-2xx responses.
 * The bot can switch on error.code reliably.
 *
 * JSON shape:
 * { "error": { "code": "SOME_CODE", "message": "Human-friendly text" } }
 */

export type ErrorCode =
    | 'UNAUTHORIZED'
    | 'VALIDATION_ERROR'
    | 'RUN_NOT_FOUND'
    | 'INVALID_STATUS_TRANSITION'
    | 'ALREADY_TERMINAL'
    | 'RUN_CLOSED'
    | 'RUN_NOT_LIVE'
    | 'NOT_ORGANIZER'
    | 'NOT_AUTHORIZED'
    | 'NOT_SECURITY'
    | 'NOT_OFFICER'
    | 'IGN_ALREADY_IN_USE'
    | 'PUNISHMENT_NOT_FOUND'
    | 'RATE_LIMITED'
    | 'INTERNAL_ERROR';

export interface ApiErrorPayload {
    error: {
        code: ErrorCode;
        message: string;
    };
}

/** Build the error payload (use this in route handlers). */
export function apiError(code: ErrorCode, message: string): ApiErrorPayload {
    return { error: { code, message } };
}

/**
 * Fastify-friendly helper: reply with a status + unified error payload.
 * Usage: return sendError(reply, 401, 'UNAUTHORIZED', 'invalid api key');
 */
import type { FastifyReply } from 'fastify';

export function sendError(
    reply: FastifyReply,
    status: number,
    code: ErrorCode,
    message: string
) {
    return reply.code(status).send(apiError(code, message));
}

/* -------------------------------------------
 * Convenience shorthands for common cases.
 * These keep routes terse and consistent.
 * ------------------------------------------*/
export const Errors = {
    unauthorized: (reply: FastifyReply) =>
        sendError(reply, 401, 'UNAUTHORIZED', 'invalid api key'),

    validation: (reply: FastifyReply, message = 'request validation failed') =>
        sendError(reply, 400, 'VALIDATION_ERROR', message),

    runNotFound: (reply: FastifyReply, runId?: string | number) =>
        sendError(
            reply,
            404,
            'RUN_NOT_FOUND',
            runId ? `run ${runId} was not found` : 'run was not found'
        ),

    invalidStatusTransition: (
        reply: FastifyReply,
        from: string,
        to: string
    ) =>
        sendError(
            reply,
            409,
            'INVALID_STATUS_TRANSITION',
            `cannot transition run status from "${from}" to "${to}"`
        ),

    alreadyTerminal: (reply: FastifyReply) =>
        sendError(
            reply,
            409,
            'ALREADY_TERMINAL',
            'run is already in a terminal state'
        ),

    runClosed: (reply: FastifyReply) =>
        sendError(reply, 409, 'RUN_CLOSED', 'run is closed to new joins'),

    notOrganizer: (reply: FastifyReply) =>
        sendError(reply, 403, 'NOT_ORGANIZER', 'only the organizer can perform this action'),

    notAuthorized: (reply: FastifyReply, message?: string) =>
        sendError(reply, 403, 'NOT_AUTHORIZED', message || 'You must have Discord Administrator permission or the configured administrator role to perform this action'),

    notSecurity: (reply: FastifyReply) =>
        sendError(reply, 403, 'NOT_SECURITY', 'only security role can perform this action'),

    notOfficer: (reply: FastifyReply) =>
        sendError(reply, 403, 'NOT_OFFICER', 'only officer role can perform this action'),

    punishmentNotFound: (reply: FastifyReply) =>
        sendError(reply, 404, 'PUNISHMENT_NOT_FOUND', 'punishment not found'),

    rateLimited: (reply: FastifyReply, message = 'too many requests, please slow down') =>
        sendError(reply, 429, 'RATE_LIMITED', message),

    internal: (reply: FastifyReply, message = 'an internal error occurred') =>
        sendError(reply, 500, 'INTERNAL_ERROR', message),
} as const;
