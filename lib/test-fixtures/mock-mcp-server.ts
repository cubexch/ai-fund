/**
 * Shared MockMcpServer — replaces the copy-pasted versions in each connector.
 *
 * Captures tool registrations and lets tests invoke them directly,
 * exactly mimicking the @modelcontextprotocol/sdk McpServer interface.
 */

export interface RegisteredTool {
  name: string;
  description: string;
  schema: unknown;
  handler: (params: any) => Promise<any>;
}

export class MockMcpServer {
  tools = new Map<string, RegisteredTool>();

  /**
   * Register a tool — same signature as McpServer.tool().
   */
  tool(
    name: string,
    description: string,
    schema: unknown,
    handler: (params: any) => Promise<any>,
  ): void {
    this.tools.set(name, { name, description, schema, handler });
  }

  /**
   * Invoke a registered tool by name. Throws if not found.
   */
  async callTool(name: string, params: Record<string, unknown> = {}): Promise<any> {
    const t = this.tools.get(name);
    if (!t) throw new Error(`Tool "${name}" not registered`);
    return t.handler(params);
  }

  /**
   * Parse a tool's JSON response content into a JS object.
   * Handles the MCP { content: [{ type: 'text', text: '...' }] } envelope.
   */
  async callToolJson<T = unknown>(name: string, params: Record<string, unknown> = {}): Promise<{ data: T; isError: boolean; raw: any }> {
    const raw = await this.callTool(name, params);
    const text = raw?.content?.[0]?.text ?? '';
    const isError = raw?.isError === true;
    let data: T;
    try {
      data = JSON.parse(text);
    } catch {
      data = text as T;
    }
    return { data, isError, raw };
  }

  /** Get all registered tool names. */
  get toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** Check if a tool is registered. */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }
}
