import { PrismaMariaDb } from '@prisma/adapter-mariadb';

/** True when the URL asks for an encrypted connection (Aiven's URLs end in ?ssl-mode=REQUIRED). */
export function wantsSsl(u: URL) {
  const mode = (u.searchParams.get('ssl-mode') ?? u.searchParams.get('sslmode') ?? u.searchParams.get('ssl') ?? '').toLowerCase();
  return !!mode && !['disabled', 'disable', 'false', '0'].includes(mode);
}

/**
 * Prisma 7 driver adapter for MySQL 8 built from a mysql:// URL. Used by the API, seed and tests.
 * With ?ssl-mode=REQUIRED the connection is encrypted; set DB_CA_CERT (the provider's CA certificate, PEM)
 * to also check the server's certificate.
 */
export function adapterFromUrl(url: string) {
  const u = new URL(url);
  const ca = process.env.DB_CA_CERT?.replace(/\\n/g, '\n');
  return new PrismaMariaDb({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    connectionLimit: Number(u.searchParams.get('connection_limit') ?? 10),
    allowPublicKeyRetrieval: true,
    ...(wantsSsl(u) ? { ssl: ca ? { ca } : { rejectUnauthorized: false } } : {}),
  });
}
