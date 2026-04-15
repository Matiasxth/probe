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

  // Blast radius header
  const br = result.blastRadius;
  const levelColor = br.level === 'CRITICAL' ? chalk.red.bold : br.level === 'HIGH' ? chalk.red : br.level === 'MEDIUM' ? chalk.yellow : chalk.green;
  console.log(`\n${levelColor(`  Blast radius: ${br.level}`)} ${chalk.dim(`(score: ${br.score}/100)`)}`);
  console.log(chalk.dim(`  ${br.signatureBreaks} signature breaks, ${br.behaviorAffects} behavior affects, ${br.coreFiles} core files, ${br.testFiles} test files`));

  // Target
  console.log(chalk.cyan(`\n  Target:`) + ` ${result.target.symbol}`);
  console.log(chalk.dim(`  ${result.target.file}:${result.target.line}`));
  console.log(chalk.dim(`  ${result.target.signature}`));

  // Dependencies (what this function calls)
  if (result.dependencies.length > 0) {
    console.log(chalk.white.bold('\n━━ Depends on (break if these change) ━━━━━━━━━━'));
    for (const dep of result.dependencies) {
      console.log(`  ${chalk.blue(dep.file)}:${chalk.dim(String(dep.line))} ← ${chalk.white(dep.symbol)}()`);
    }
  }

  // Direct dependents (signature breaks)
  if (result.directDependents.length > 0) {
    console.log(chalk.white.bold('\n━━ Signature dependents (break if you change params/return) ━━'));
    for (const dep of result.directDependents) {
      const typeIcon = dep.type === 'call' ? '→' : dep.type === 'type' ? '⊳' : '↠';
      const riskIcon = dep.risk === 'high' ? chalk.red('●') : dep.risk === 'medium' ? chalk.yellow('●') : chalk.dim('○');
      console.log(`  ${riskIcon} ${chalk.blue(dep.file)}:${chalk.dim(String(dep.line))} ${typeIcon} ${chalk.white(dep.symbol)}()`);
    }
  }

  // Indirect dependents (behavior affects)
  if (result.indirectDependents.length > 0) {
    console.log(chalk.white.bold('\n━━ Behavior dependents (affected if logic changes) ━━'));
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
  } else if (br.signatureBreaks > 0) {
    console.log(chalk.yellow('\n  ⚠ No tests cover this function — risk is higher'));
  }
}
