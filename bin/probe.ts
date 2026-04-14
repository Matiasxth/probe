import { Command } from 'commander';
import { indexCommand } from '../src/commands/index-cmd.js';
import { queryCommand } from '../src/commands/query-cmd.js';
import { impactCommand } from '../src/commands/impact-cmd.js';
import { patternsCommand } from '../src/commands/patterns-cmd.js';
import { serveCommand } from '../src/commands/serve-cmd.js';
import { statsCommand } from '../src/commands/stats-cmd.js';

declare const globalThis: { __PROBE_VERSION__: string };
const version = globalThis.__PROBE_VERSION__ ?? '0.0.0-dev';

const program = new Command();

program
  .name('probe')
  .description('Codebase intelligence for AI agents')
  .version(version);

program
  .command('index')
  .description('Index the codebase — extract symbols, calls, patterns')
  .option('-r, --root <path>', 'Project root directory', '.')
  .option('--no-git', 'Skip git history analysis')
  .option('--full', 'Force full re-index (skip incremental)')
  .option('--verbose', 'Show detailed output')
  .action(indexCommand);

program
  .command('query <task>')
  .description('Find relevant files and symbols for a task')
  .option('-r, --root <path>', 'Project root directory', '.')
  .option('-n, --limit <n>', 'Max results', '15')
  .option('--json', 'Output as JSON')
  .action(queryCommand);

program
  .command('impact <target>')
  .description('Show what breaks if you change a file or function')
  .option('-r, --root <path>', 'Project root directory', '.')
  .option('--depth <n>', 'Max traversal depth', '3')
  .option('--json', 'Output as JSON')
  .action(impactCommand);

program
  .command('patterns')
  .description('Show extracted codebase conventions')
  .option('-r, --root <path>', 'Project root directory', '.')
  .option('--json', 'Output as JSON')
  .action(patternsCommand);

program
  .command('stats')
  .description('Show index statistics')
  .option('-r, --root <path>', 'Project root directory', '.')
  .option('--json', 'Output as JSON')
  .action(statsCommand);

program
  .command('serve')
  .description('Start MCP server for AI agent integration')
  .option('-r, --root <path>', 'Project root directory', '.')
  .action(serveCommand);

program.parse();
