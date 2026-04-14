import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { writeDefaultConfig } from '../config.js';

export async function initConfigCommand(opts: { root: string }): Promise<void> {
  const root = path.resolve(opts.root);
  const configPath = path.join(root, '.probe', 'config.json');

  if (fs.existsSync(configPath)) {
    console.log(chalk.yellow('Config already exists:') + ` ${configPath}`);
    return;
  }

  const written = writeDefaultConfig(root);
  console.log(chalk.green('Created config:') + ` ${written}`);
  console.log(chalk.dim('Edit to customize exclusions, languages, and git history settings.'));
}
