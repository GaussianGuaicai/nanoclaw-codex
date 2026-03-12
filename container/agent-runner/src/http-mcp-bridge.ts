import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseHeaders(): Record<string, string> {
  const raw = process.env.NANOCLAW_REMOTE_MCP_HEADERS_JSON;
  if (!raw) return {};

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).filter(
      ([key, value]) => typeof key === 'string' && typeof value === 'string',
    ),
  ) as Record<string, string>;
}

async function main(): Promise<void> {
  const bridgeName =
    process.env.NANOCLAW_REMOTE_MCP_NAME || 'nanoclaw-remote-mcp-bridge';
  const bridgeUrl = new URL(getRequiredEnv('NANOCLAW_REMOTE_MCP_URL'));
  const requestHeaders = parseHeaders();

  const client = new Client(
    {
      name: `${bridgeName}-bridge-client`,
      version: '1.0.0',
    },
    {
      capabilities: {},
    },
  );
  const transport = new StreamableHTTPClientTransport(bridgeUrl, {
    requestInit: {
      headers: requestHeaders,
    },
  });
  await client.connect(transport);

  const remoteCapabilities = client.getServerCapabilities() || {};
  const server = new Server(
    {
      name: bridgeName,
      version: '1.0.0',
    },
    {
      capabilities: {
        ...(remoteCapabilities.tools
          ? {
              tools: {
                listChanged: remoteCapabilities.tools.listChanged ?? false,
              },
            }
          : {}),
        ...(remoteCapabilities.resources
          ? {
              resources: {
                subscribe: remoteCapabilities.resources.subscribe ?? false,
                listChanged: remoteCapabilities.resources.listChanged ?? false,
              },
            }
          : {}),
        ...(remoteCapabilities.prompts
          ? {
              prompts: {
                listChanged: remoteCapabilities.prompts.listChanged ?? false,
              },
            }
          : {}),
        ...(remoteCapabilities.completions
          ? {
              completions: {},
            }
          : {}),
      },
    },
  );

  if (remoteCapabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async (request) =>
      client.listTools(request.params),
    );
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      client.callTool(request.params),
    );
  }

  if (remoteCapabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) =>
      client.listResources(request.params),
    );
    server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async (request) => client.listResourceTemplates(request.params),
    );
    server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
      client.readResource(request.params),
    );
  }

  if (remoteCapabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) =>
      client.listPrompts(request.params),
    );
    server.setRequestHandler(GetPromptRequestSchema, async (request) =>
      client.getPrompt(request.params),
    );
  }

  if (
    !remoteCapabilities.tools &&
    !remoteCapabilities.resources &&
    !remoteCapabilities.prompts
  ) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'Remote MCP server exposed no bridgeable capabilities',
    );
  }

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[http-mcp-bridge] ${message}`);
  process.exit(1);
});
