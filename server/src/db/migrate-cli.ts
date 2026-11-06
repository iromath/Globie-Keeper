import { closePool } from './pool.js';
import { runMigrations } from './migrate.js';

try {
  const ran = await runMigrations();
  console.log(`[db] ${ran.length} migration(s) applied`);
} finally {
  await closePool();
}
