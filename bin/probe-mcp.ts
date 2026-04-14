import { serveCommand } from '../src/commands/serve-cmd.js';

// Direct MCP server entry — for use in agent configs:
// { "command": "npx", "args": ["probe-mcp", "."] }
const root = process.argv[2] || '.';
serveCommand({ root });
