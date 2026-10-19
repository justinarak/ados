import { AdOSGateway } from "@ados/gateway";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ADOS_MCP_TOOLS, executeAdOSMcpTool } from "./tools.js";

export * from "./tools.js";

export function createAdOSMcpServer(gateway: AdOSGateway = new AdOSGateway()): Server {
  const server = new Server(
    {
      name: "@ados/mcp-server",
      version: "0.1.0-alpha.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [...ADOS_MCP_TOOLS],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await executeAdOSMcpTool(gateway, toolName, args);
    return {
      content: result.content,
      isError: result.isError,
    };
  });

  return server;
}

export async function startStdioMcpServer(gateway?: AdOSGateway): Promise<void> {
  const server = createAdOSMcpServer(gateway);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
