import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/** Prisma's own tools (migrate) do not understand ?ssl-mode=REQUIRED (Aiven's URLs): use their TLS option instead. */
function cliUrl(raw: string) {
  const u = new URL(raw);
  const mode = (u.searchParams.get('ssl-mode') ?? u.searchParams.get('sslmode') ?? '').toLowerCase();
  u.searchParams.delete('ssl-mode');
  u.searchParams.delete('sslmode');
  u.searchParams.delete('connection_limit');
  if (mode && !['disabled', 'disable'].includes(mode) && !u.searchParams.has('sslaccept')) u.searchParams.set('sslaccept', 'accept_invalid_certs');
  return u.toString();
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: { url: cliUrl(process.env.DATABASE_URL ?? 'mysql://cps:cpspass@127.0.0.1:3306/cps_erp') },
});
