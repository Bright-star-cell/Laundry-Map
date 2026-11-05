import { z } from 'zod';
import { loadBackendEnvironment } from './load-env.js';

loadBackendEnvironment();

function createEnvironmentSchema(production: boolean) {
  const originList = z.string().min(1).transform((value, context) => {
    const origins = value.split(',').map((origin) => origin.trim());
    for (const origin of origins) {
      try {
        const parsed = new URL(origin);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
          throw new Error();
        }
        if (production && parsed.protocol !== 'https:') throw new Error();
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'must contain valid origins (HTTPS in production)' });
        return z.NEVER;
      }
    }
    return origins;
  });

  return z.object({
    JWT_SECRET: z.string().min(32),
    WEB_ORIGIN: originList,
    NEXT_PUBLIC_API_URL: z.string().url().refine((value) => {
      const parsed = new URL(value);
      const isOrigin = parsed.origin === value.replace(/\/$/, '') && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash;
      const isSecure = parsed.protocol === 'https:' || (!production && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname));
      return isOrigin && isSecure;
    }, 'must be HTTPS in production and a valid URL in development'),
    JWT_EXPIRES_IN: z.string().default('12h'),
    TRUST_PROXY: (production ? z.string().min(1) : z.string().default('loopback')).transform((value) => /^\d+$/.test(value) ? Number(value) : value),
    SOCKET_IO_TRANSPORTS: z.string().default('websocket,polling').transform((value, context) => {
      const transports = value.split(',').map((transport) => transport.trim());
      if (transports.length === 0 || transports.some((transport) => !['websocket', 'polling'].includes(transport))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a comma-separated list of websocket and/or polling' });
        return z.NEVER;
      }
      return transports as ('websocket' | 'polling')[];
    }),
  });
}

export function validateRuntimeEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const production = environment.NODE_ENV === 'production';
  const parsed = createEnvironmentSchema(production).safeParse(environment);
  if (!parsed.success) {
    const invalidVariables = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid runtime configuration: ${invalidVariables.join(', ')}`);
  }
  return { ...parsed.data, production, socketTransports: parsed.data.SOCKET_IO_TRANSPORTS };
}

export const config = validateRuntimeEnvironment();