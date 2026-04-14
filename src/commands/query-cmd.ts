import path from 'path';
import chalk from 'chalk';
import { openDatabase } from '../storage/database.js';
import { queryCodebase } from '../engine/query.js';

export async function queryCommand(task: string, opts: { root: string; limit: string; json?: boolean }): Promise<void> {
  const root = path.resolve(opts.root);
  const db = openDatabase(root);
  const limit = parseInt(opts.limit, 10) || 15;

  const results = queryCodebase(db, task, { limit });
  db.close();

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(chalk.yellow('No results found. Try different keywords or run `probe index` first.'));
    return;
  }

  console.log(chalk.cyan(`Found ${results.length} relevant items for`) + ` "${task}"\n`);

  // Group by relevance tiers
  const primary = results.filter((r) => r.relevance >= 60);
  const related = results.filter((r) => r.relevance >= 30 && r.relevance < 60);
  const coChange = results.filter((r) => r.relevance < 30);

  if (primary.length > 0) {
    console.log(chalk.white.bold('━━ Primary matches ━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    for (const r of primary) {
      printResult(r);
    }
  }

  if (related.length > 0) {
    console.log(chalk.white.bold('\n━━ Related ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    for (const r of related) {
      printResult(r);
    }
  }

  if (coChange.length > 0) {
    console.log(chalk.white.bold('\n━━ Co-change correlation ━━━━━━━━━━━━━━━━━━━━━'));
    for (const r of coChange) {
      printResult(r);
    }
  }
}

function printResult(r: ReturnType<typeof queryCodebase>[0]): void {
  const location = r.symbol
    ? `${chalk.blue(r.file)} → ${chalk.white(r.symbol)}()` + (r.line ? chalk.dim(` [line ${r.line}]`) : '')
    : chalk.blue(r.file);

  console.log(`\n  ${location}`);
  if (r.signature) console.log(chalk.dim(`  ${r.signature}`));
  console.log(chalk.dim(`  ${r.reason}`));

  if (r.calledBy.length > 0) {
    console.log(chalk.dim(`  Called by: ${r.calledBy.slice(0, 3).join(', ')}`));
  }
  if (r.calls.length > 0) {
    console.log(chalk.dim(`  Calls: ${r.calls.slice(0, 3).join(', ')}`));
  }
}
