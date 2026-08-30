import { z } from 'zod';

/** Validate the entire decimal representation, never a parseFloat prefix or binary product. */
export const DecimalPointsSchema = z.union([z.string().trim(), z.number().finite()])
    .transform(value => String(value))
    .pipe(z.string().regex(/^\d{1,8}(?:\.\d{1,2})?$/, 'Use a nonnegative number with at most two decimal places (maximum 99999999.99).'))
    .transform(value => Number(value));
