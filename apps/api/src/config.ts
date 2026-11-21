import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().startsWith('mysql://'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  SCHOOL_CODE: z.string().default('CPS'),
  STORAGE_DIR: z.string().default('./storage'),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(5),
  /** All other requests, per client IP. A whole school behind one router shares one IP, so keep this generous. */
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(1200),
  CORS_ORIGIN: z.string().optional(),
  /** Express "trust proxy": 'loopback' locally; on a host behind a load balancer (Render) set the number of proxy hops, e.g. 1, or true. */
  TRUST_PROXY: z.string().default('loopback'),
  /** Folder of the built website (apps/web/dist). When set, the API also serves the website, so both share one address. */
  WEB_DIST: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

/** Validated environment. Fails fast at boot with a readable message. */
export function config(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${msg}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.JWT_ACCESS_SECRET.startsWith('change-me')) {
    throw new Error('JWT_ACCESS_SECRET must be changed in production');
  }
  cached = parsed.data;
  return cached;
}

/** For tests that change env between app instances. */
export function resetConfigCache() {
  cached = undefined;
}
