/**
 * Unified error shape for ALL non-2xx responses.
 * The bot can switch on error.code reliably.
 *
 * JSON shape:
 * { "error": { "code": "SOME_CODE", "message": "Human-friendly text" } }
 */
/** Build the error payload (use this in route handlers). */
export function apiError(code, message) {
    return { error: { code, message } };
}
export function sendError(reply, status, code, message) {
    return reply.code(status).send(apiError(code, message));
}
/* -------------------------------------------
 * Convenience shorthands for common cases.
 * These keep routes terse and consistent.
 * ------------------------------------------*/
export const Errors = {
    unauthorized: (reply) => sendError(reply, 401, 'UNAUTHORIZED', 'invalid api key'),
    validation: (reply, message = 'request validation failed') => sendError(reply, 400, 'VALIDATION_ERROR', message),
    runNotFound: (reply, runId) => sendError(reply, 404, 'RUN_NOT_FOUND', runId ? `run ${runId} was not found` : 'run was not found'),
    invalidStatusTransition: (reply, from, to) => sendError(reply, 409, 'INVALID_STATUS_TRANSITION', `cannot transition run status from "${from}" to "${to}"`),
    alreadyTerminal: (reply) => sendError(reply, 409, 'ALREADY_TERMINAL', 'run is already in a terminal state'),
    runClosed: (reply) => sendError(reply, 409, 'RUN_CLOSED', 'run is closed to new joins'),
    notOrganizer: (reply) => sendError(reply, 403, 'NOT_ORGANIZER', 'only the organizer can perform this action'),
    notAuthorized: (reply, message) => sendError(reply, 403, 'NOT_AUTHORIZED', message || 'You must have Discord Administrator permission or the configured administrator role to perform this action'),
    notSecurity: (reply) => sendError(reply, 403, 'NOT_SECURITY', 'only security role can perform this action'),
    punishmentNotFound: (reply) => sendError(reply, 404, 'PUNISHMENT_NOT_FOUND', 'punishment not found'),
    internal: (reply, message = 'an internal error occurred') => sendError(reply, 500, 'INTERNAL_ERROR', message),
};
