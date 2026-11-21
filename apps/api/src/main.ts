import 'reflect-metadata';
import { createApp } from './bootstrap';
import { config } from './config';

async function main() {
  const app = await createApp();
  await app.listen(config().PORT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
