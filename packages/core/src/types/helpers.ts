/**
 * Schema validation helpers
 */
import { z } from 'zod';

// =============================================================================
// SCHEMA VALIDATION HELPERS
// =============================================================================

/**
 * Parse and validate JSON with a Zod schema, returning a Result type
 */
export function safeParseJson<T>(
  json: string,
  schema: z.ZodSchema<T>
): { success: true; data: T } | { success: false; error: z.ZodError } {
  try {
    const parsed = JSON.parse(json);
    return schema.safeParse(parsed);
  } catch {
    return {
      success: false,
      error: new z.ZodError([{
        code: 'custom',
        message: 'Invalid JSON',
        path: [],
      }]),
    };
  }
}

/**
 * Parse JSON with a Zod schema, throwing on error
 */
export function parseJson<T>(json: string, schema: z.ZodSchema<T>): T {
  const parsed = JSON.parse(json);
  return schema.parse(parsed);
}
