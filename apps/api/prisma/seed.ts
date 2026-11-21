import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { adapterFromUrl } from '../src/infra/db-adapter';
import { convertToGreensheet } from './greensheet-convert';
import { seedBase } from './seed-data';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
  const prisma = new PrismaClient({ adapter: adapterFromUrl(url) });
  try {
    await seedBase(prisma, {
      schoolCode: process.env.SCHOOL_CODE ?? 'CPS',
      adminUsername: process.env.SEED_ADMIN_USERNAME ?? 'admin',
      adminPassword: process.env.SEED_ADMIN_PASSWORD || undefined,
      log: (m) => console.log(m),
    });
    await convertToGreensheet(prisma, (m) => console.log(m));
    console.log('Seed complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
