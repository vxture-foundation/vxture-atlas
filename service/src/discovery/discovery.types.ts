/** product_210 §4.1 tool descriptor shape. */
export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  /**
   * product_210 §4.1a: where to actually call this tool. `path` is relative
   * to Atlas's own base URL, which a consumer already has from its own
   * config/registry - it must never become a second place a hostname lives.
   */
  endpoint: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string };
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  version: string;
  deprecated: boolean;
  metering?: { metric: string; mode: "per_call" | "per_unit" };
  authz?: { asset_types: string[] };
}

export interface VxtureToolsResponse {
  protocol_version: string;
  tools: ToolDescriptor[];
}
