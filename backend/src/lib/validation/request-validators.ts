import { FastifyReply } from 'fastify';
import { z, ZodSchema } from 'zod';
import { Errors } from '../errors/errors.js';

/**
 * Validates request parameters/body using a Zod schema and returns parsed data or sends error response.
 * Returns null if validation fails (error response is sent automatically).
 * 
 * @param schema - Zod schema to validate against
 * @param data - Data to validate (req.params, req.body, req.query, etc.)
 * @param reply - Fastify reply object
 * @returns Parsed data if valid, null if invalid (error already sent)
 * 
 * @example
 * const data = validateRequest(CreateRunSchema, req.body, reply);
 * if (!data) return; // Error response already sent
 * // Use data.field here
 */
export function validateRequest<T extends ZodSchema>(
    schema: T,
    data: unknown,
    reply: FastifyReply
): z.infer<T> | null {
    const parsed = schema.safeParse(data);
    
    if (!parsed.success) {
        const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        Errors.validation(reply, msg || 'Invalid request');
        return null;
    }
    
    return parsed.data;
}

/**
 * Validates multiple request data sources at once (e.g., params + body).
 * Returns null if any validation fails (error response is sent automatically).
 * 
 * @param validations - Array of [schema, data] tuples to validate
 * @param reply - Fastify reply object
 * @returns Array of parsed data if all valid, null if any invalid
 * 
 * @example
 * const validated = validateMultiple([
 *     [ParamsSchema, req.params],
 *     [BodySchema, req.body]
 * ], reply);
 * if (!validated) return;
 * const [params, body] = validated;
 */
export function validateMultiple(
    validations: Array<[ZodSchema, unknown]>,
    reply: FastifyReply
): any[] | null {
    const results: any[] = [];
    const allErrors: string[] = [];
    
    for (const [schema, data] of validations) {
        const parsed = schema.safeParse(data);
        
        if (!parsed.success) {
            const errors = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
            allErrors.push(...errors);
        } else {
            results.push(parsed.data);
        }
    }
    
    if (allErrors.length > 0) {
        Errors.validation(reply, allErrors.join('; '));
        return null;
    }
    
    return results;
}

/**
 * Validates a snowflake ID (Discord ID) parameter.
 * 
 * @param value - Value to validate
 * @param reply - Fastify reply object
 * @param fieldName - Name of field for error message
 * @returns Validated snowflake or null if invalid
 */
export function validateSnowflake(
    value: unknown,
    reply: FastifyReply,
    fieldName = 'id'
): string | null {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        Errors.validation(reply, `Invalid ${fieldName}: must be a valid Discord ID`);
        return null;
    }
    return value;
}
