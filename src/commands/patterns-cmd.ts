import path from 'path';
import chalk from 'chalk';
import { openDatabase } from '../storage/database.js';
import { getPatterns } from '../storage/queries.js';

export async function patternsCommand(opts: { root: string; json?: boolean }): Promise<void> {
  const root = path.resolve(opts.root);
  const db = openDatabase(root);

  const patterns = getPatterns(db);
  db.close();

  if (opts.json) {
    console.log(JSON.stringify(patterns, null, 2));
    return;
  }

  if (patterns.length === 0) {
    console.log(chalk.yellow('No patterns found. Run `probe index` first.'));
    return;
  }

  console.log(chalk.cyan('\nCodebase patterns\n'));

  // Group by category
  const categories = new Map<string, typeof patterns>();
  for (const p of patterns) {
    const cat = categories.get(p.category) ?? [];
    cat.push(p);
    categories.set(p.category, cat);
  }

  const categoryLabels: Record<string, string> = {
    naming: 'Naming',
    error_handling: 'Error handling',
    structure: 'Structure',
    tests: 'Tests',
    imports: 'Imports',
  };

  for (const [category, items] of categories) {
    const label = categoryLabels[category] ?? category;
    console.log(chalk.white.bold(`━━ ${label} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));

    for (const p of items) {
      const pct = Math.round(p.confidence * 100);
      const ratio = `${p.instance_count}/${p.total_count}`;

      if (p.name.includes('outlier')) {
        console.log(chalk.yellow(`  Outliers: ${p.value}`));
      } else {
        console.log(`  ${chalk.white(p.name)}: ${chalk.green(p.value)} ${chalk.dim(`(${ratio} — ${pct}%)`)}`);
      }

      const examples = JSON.parse(p.examples) as string[];
      if (examples.length > 0) {
        for (const ex of examples.slice(0, 2)) {
          console.log(chalk.dim(`    ${ex}`));
        }
      }
    }
    console.log();
  }
}
