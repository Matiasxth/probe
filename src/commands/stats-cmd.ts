import path from 'path';
import chalk from 'chalk';
import { openDatabase, getMeta } from '../storage/database.js';
import { getStats } from '../storage/queries.js';

export async function statsCommand(opts: { root: string; json?: boolean }): Promise<void> {
  const root = path.resolve(opts.root);
  const db = openDatabase(root);

  const stats = getStats(db);
  const indexedAt = getMeta(db, 'indexed_at') ?? 'unknown';
  const duration = getMeta(db, 'duration_ms');
  const version = getMeta(db, 'version') ?? 'unknown';

  db.close();

  if (opts.json) {
    console.log(JSON.stringify({ ...stats, indexedAt, duration, version }, null, 2));
    return;
  }

  console.log(chalk.cyan('\nprobe index stats\n'));
  console.log(`  Files:       ${chalk.white(String(stats.files))}`);
  console.log(`  Symbols:     ${chalk.white(String(stats.symbols))}`);
  console.log(`  Call edges:  ${chalk.white(String(stats.calls))}`);
  console.log(`  Co-changes:  ${chalk.white(String(stats.coChanges))}`);
  console.log(`  Patterns:    ${chalk.white(String(stats.patterns))}`);
  console.log();
  console.log(`  Languages:`);
  for (const [lang, count] of Object.entries(stats.languages)) {
    console.log(`    ${lang}: ${chalk.white(String(count))} files`);
  }
  console.log();
  console.log(chalk.dim(`  Indexed: ${indexedAt}`));
  if (duration) console.log(chalk.dim(`  Duration: ${(parseInt(duration) / 1000).toFixed(1)}s`));
  console.log(chalk.dim(`  Version: ${version}`));
}
