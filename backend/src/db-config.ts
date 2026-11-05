import { z } from 'zod';

export function validateDatabaseEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const production = environment.NODE_ENV === 'production';
  const schema = z.object({
    DATABASE_URL: z.string().url().refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
    DATABASE_SSL: production ? z.literal('true') : z.enum(['true', 'false']).default('false'),
    REDIS_URL: z.string().url().refine((value) => ['redis:', 'rediss:'].includes(new URL(value).protocol)),
  });
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    const invalidVariables = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid database configuration: ${invalidVariables.join(', ')}`);
  }
  if (production && (!parsed.data.REDIS_URL.startsWith('rediss://') || !new URL(parsed.data.REDIS_URL).password)) {
    throw new Error('Production REDIS_URL must use rediss:// with an authenticated connection');
  }
  return parsed.data;
}