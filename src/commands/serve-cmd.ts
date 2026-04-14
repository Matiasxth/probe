import path from 'path';
import { startMcpServer } from '../mcp/server.js';

export async function serveCommand(opts: { root: string }): Promise<void> {
  const root = path.resolve(opts.root);
  await startMcpServer(root);
}
