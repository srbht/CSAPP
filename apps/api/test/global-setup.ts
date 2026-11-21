import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDB } from 'mysql-memory-server';

/** Starts a throwaway MySQL 8.4, applies the real migrations, and exposes env for the tests. */
export default async function globalSetup() {
  const db = await createDB({ version: '8.4.x', logLevel: 'ERROR', dbName: 'cps_test' });
  (globalThis as Record<string, unknown>).__MYSQL__ = db;
  const url = `mysql://${db.username}@127.0.0.1:${db.port}/${db.dbName}`;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: url,
    JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-123456',
    SCHOOL_CODE: 'CPS',
    STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'cps-storage-')),
    LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
  });
  try {
    execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'pipe' });
  } catch (e) {
    // Jest skips teardown when setup throws: stop the server here so no mysqld is left running.
    await db.stop();
    throw e;
  }
}
