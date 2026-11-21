/**
 * Throwaway local MySQL for trying the app WITHOUT Docker or a MySQL install.
 * Starts MySQL 8.4 on a free port, applies migrations, seeds the school and prints the admin login.
 *
 * ⚠ Data is lost when this process stops. For real development use `docker compose up -d`
 * (persistent) or a native MySQL 8 install, and point DATABASE_URL at it.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createDB } from 'mysql-memory-server';
import { PrismaClient } from '../src/generated/prisma/client';
import { adapterFromUrl } from '../src/infra/db-adapter';
import { seedBase } from '../prisma/seed-data';

async function main() {
  // A free port is chosen automatically unless DEV_DB_PORT is set; the URL to use is printed below.
  const port = process.env.DEV_DB_PORT ? Number(process.env.DEV_DB_PORT) : undefined;
  console.log('Starting temporary MySQL 8.4 (first run downloads MySQL, ~2 min)…');
  const db = await createDB({ version: '8.4.x', ...(port ? { port } : {}), dbName: 'cps_erp', logLevel: 'ERROR' });
  const url = `mysql://${db.username}@127.0.0.1:${db.port}/${db.dbName}`;
  execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  const prisma = new PrismaClient({ adapter: adapterFromUrl(url) });
  const password = process.env.SEED_ADMIN_PASSWORD || 'Admin-temp-2026';
  await seedBase(prisma, { schoolCode: 'CPS', adminUsername: 'admin', adminPassword: password });
  await prisma.$disconnect();
  console.log('\nTemporary database ready.');
  console.log(`  DATABASE_URL=${url}`);
  console.log(`  Sign in as: admin / ${password}  (you will be asked to change it)`);
  console.log('\nIn other terminals run:  npm run dev:api,  npm run dev:web,  then (optional) npm run sample-data');
  console.log('Press Ctrl+C to stop (all data is discarded).');
  const stop = async () => {
    await db.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
