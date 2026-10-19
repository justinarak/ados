import { AdOSGateway } from "@ados/gateway";
export interface MCPToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
/**
 * Section 7: The AdOS Core MCP Tool Registry (All 5 Core Tools)
 */
export declare const ADOS_MCP_TOOLS: readonly MCPToolDefinition[];
export declare function executeAdOSMcpTool(gateway: AdOSGateway, toolName: string, args: Record<string, unknown>): Promise<{
    isError?: boolean;
    content: Array<{
        type: "text";
        text: string;
    }>;
    structuredResult: unknown;
}>;
//# sourceMappingURL=tools.d.ts.map