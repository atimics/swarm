#!/usr/bin/env node
/**
 * CLI entry point for the MCP Server
 * 
 * Starts the MCP server with stdio transport for use by MCP clients.
 * 
 * Environment variables:
 *   AVATAR_ID - Default avatar ID for tool context
 *   ADMIN_API_URL - Admin API URL for remote tool execution
 */
import { runMCPServer } from './server.js';
import { ToolRegistry } from './registry.js';
import { createDiagnosticsTools } from './tools/diagnostics.js';

// Get config from environment
const avatarId = process.env.AVATAR_ID || 'default';

// Create registry and register available tools
const registry = new ToolRegistry();

// Register tools that don't require external services
const diagnosticsTools = createDiagnosticsTools();
console.error(`[MCP CLI] Registering ${diagnosticsTools.length} diagnostics tools`);
registry.registerAll(diagnosticsTools);
console.error(`[MCP CLI] Registry now has ${registry.getAll().length} tools`);

// Run the server
runMCPServer({
  name: 'swarm-tools',
  version: '1.0.0',
  registry,
  defaultContext: {
    platform: 'mcp',
  },
  resolveAvatarId: (meta) => {
    // Allow avatarId override via request metadata, fall back to env var
    return (meta?.avatarId as string) || avatarId;
  },
}).catch((err) => {
  console.error('[MCP Server] Fatal error:', err);
  process.exit(1);
});
