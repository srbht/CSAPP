export default async function globalTeardown() {
  const db = (globalThis as Record<string, unknown>).__MYSQL__ as { stop: () => Promise<void> } | undefined;
  await db?.stop();
}
