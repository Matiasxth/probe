import path from 'path';
import chalk from 'chalk';
import { openDatabase } from '../storage/database.js';
import { analyzeImpact } from '../engine/impact.js';

export async function impactCommand(target: string, opts: { root: string; depth: string; json?: boolean }): Promise<void> {
  const root = path.resolve(opts.root);
  const db = openDatabase(root);
  const depth = parseInt(opts.depth, 10) || 3;

  const result = analyzeImpact(db, target, depth);
  db.close();

  if (!result) {
    console.log(chalk.yellow(`Symbol not found: "${target}". Try "file.ts:line" or "functionName".`));
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Header
  console.log(chalk.cyan(`\nImpact analysis for:`) + ` ${result.target.symbol}`);
  console.log(chalk.dim(`  ${result.target.file}:${result.target.line}`));
  console.log(chalk.dim(`  ${result.target.signature}`));

  // Direct dependents
  if (result.directDependents.length > 0) {
    console.log(chalk.white.bold('\n━━ Direct dependents (break if signature changes) ━━'));
    for (const dep of result.directDependents) {
      const typeIcon = dep.type === 'call' ? '→' : dep.type === 'type' ? '⊳' : '↠';
      console.log(`  ${chalk.blue(dep.file)}:${chalk.dim(String(dep.line))} ${typeIcon} ${chalk.white(dep.symbol)}() ${chalk.dim(`[${dep.type}]`)}`);
    }
  }

  // Indirect dependents
  if (result.indirectDependents.length > 0) {
    console.log(chalk.white.bold('\n━━ Indirect dependents ━━━━━━━━━━━━━━━━━━━━━━━━━'));
    for (const dep of result.indirectDependents) {
      const indent = '  '.repeat(dep.depth);
      console.log(`${indent}${chalk.blue(dep.file)}:${chalk.dim(String(dep.line))} → ${chalk.white(dep.symbol)}() ${chalk.dim(`[depth ${dep.depth}]`)}`);
    }
  }

  // Co-change correlations
  if (result.coChangeCorrelations.length > 0) {
    console.log(chalk.white.bold('\n━━ Co-change history ━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    for (const cc of result.coChangeCorrelations) {
      const pct = Math.round(cc.confidence * 100);
      const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
      console.log(`  ${chalk.blue(cc.file)} ${chalk.dim(bar)} ${pct}% (${cc.changeCount} times)`);
    }
  }

  // Tests
  if (result.tests.length > 0) {
    console.log(chalk.white.bold('\n━━ Tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    for (const test of result.tests) {
      const label = test.testName ? `${test.testName}()` : 'file';
      console.log(`  ${chalk.green('✓')} ${chalk.blue(test.file)}:${chalk.dim(String(test.line))} ${chalk.dim(label)}`);
    }
  }

  // Summary
  const total = result.directDependents.length + result.indirectDependents.length;
  console.log(chalk.dim(`\n  ${total} dependents, ${result.tests.length} tests, ${result.coChangeCorrelations.length} co-changes`));
}
