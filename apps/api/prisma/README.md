# Database migrations

- Schema: `schema.prisma` (Prisma 7, MySQL 8.4). Migrations: `migrations/` applied with `npm run db:migrate`.
- Some integrity rules are added as **raw SQL** at the end of migrations because Prisma cannot model them:
  CHECK constraints (`chk_*`) and functional unique indexes (`ux_*`), e.g. "one current academic year",
  "one active class teacher per division". When you generate a new migration
  (`prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script`),
  **delete any statement that drops a `chk_*` or `ux_*` object** before committing it.
- The application never hard-deletes records referenced by history; it sets `status = 'INACTIVE'`.
