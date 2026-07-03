/**
 * JSON-RPC 2.0 & Model Context Protocol (MCP) type definitions.
 *
 * These types model the wire format that MCP-Shield intercepts on stdio:
 * every packet exchanged between an MCP client (e.g. Claude Code) and an
 * MCP server is a JSON-RPC 2.0 message, and MCP layers its own methods
 * (`initialize`, `tools/call`, `resources/read`, ...) on top of it.
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 base protocol
// ---------------------------------------------------------------------------

export const JSONRPC_VERSION = '2.0' as const;

/** A request id. The spec allows string, number or null (null only in error responses to unparseable requests). */
export type JsonRpcId = string | number | null;

/** A request expects a response and therefore always carries an id. */
export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

/** A notification is fire-and-forget: same shape as a request but without id. */
export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** Any valid JSON-RPC 2.0 packet that can travel over the stdio pipe. */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Standard JSON-RPC 2.0 error codes, plus the code MCP-Shield uses for policy denials. */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** MCP-Shield policy denial. The spec reserves -32000..-32099 for implementation-defined server errors. */
  AccessDenied: -32003,
} as const;

export type JsonRpcErrorCodeValue = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

// ---------------------------------------------------------------------------
// MCP protocol layer
// ---------------------------------------------------------------------------

/** MCP methods relevant to interception. Servers may expose more; the firewall matches on these. */
export const McpMethod = {
  Initialize: 'initialize',
  Initialized: 'notifications/initialized',
  ToolsList: 'tools/list',
  ToolsCall: 'tools/call',
  ResourcesList: 'resources/list',
  ResourcesRead: 'resources/read',
  PromptsList: 'prompts/list',
  PromptsGet: 'prompts/get',
  Ping: 'ping',
} as const;

export type McpMethodValue = (typeof McpMethod)[keyof typeof McpMethod];

/** Params of a `tools/call` request — the packet the firewall cares most about. */
export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/** A fully-typed `tools/call` request as seen on the client → server pipe. */
export interface McpToolCallRequest extends JsonRpcRequest {
  method: typeof McpMethod.ToolsCall;
  params: McpToolCallParams & Record<string, unknown>;
}

/** Tool definition as returned by `tools/list`. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolListResult {
  tools: McpTool[];
}

// --- Content blocks returned by tools (the surface the sanitizer scans) ----

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface McpEmbeddedResource {
  type: 'resource';
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

export type McpContent = McpTextContent | McpImageContent | McpEmbeddedResource;

/** Result of a `tools/call` — travels server → client and passes through the sanitizer. */
export interface McpToolCallResult {
  content: McpContent[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Type guards — parsing untrusted stdio input safely
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return isRecord(value) && value['jsonrpc'] === JSONRPC_VERSION;
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isJsonRpcMessage(value) &&
    'method' in value &&
    typeof (value as JsonRpcRequest).method === 'string' &&
    'id' in value &&
    ((value as JsonRpcRequest).id === null ||
      typeof (value as JsonRpcRequest).id === 'string' ||
      typeof (value as JsonRpcRequest).id === 'number')
  );
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return (
    isJsonRpcMessage(value) &&
    'method' in value &&
    typeof (value as JsonRpcNotification).method === 'string' &&
    !('id' in value)
  );
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isJsonRpcMessage(value) && !('method' in value) && ('result' in value || 'error' in value);
}

export function isJsonRpcErrorResponse(value: unknown): value is JsonRpcErrorResponse {
  return isJsonRpcResponse(value) && 'error' in value;
}

/** Narrow an intercepted packet down to the tool invocation the firewall must judge. */
export function isToolCallRequest(value: unknown): value is McpToolCallRequest {
  return (
    isJsonRpcRequest(value) &&
    value.method === McpMethod.ToolsCall &&
    isRecord(value.params) &&
    typeof value.params['name'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Response factories
// ---------------------------------------------------------------------------

/** Build the error response MCP-Shield returns to the client when a request is blocked by policy. */
export function createAccessDeniedResponse(id: JsonRpcId, ruleName?: string): JsonRpcErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code: JsonRpcErrorCode.AccessDenied,
      message: 'Access Denied by Policy',
      data: ruleName ? { rule: ruleName } : undefined,
    },
  };
}

export function createErrorResponse(
  id: JsonRpcId,
  code: JsonRpcErrorCodeValue | number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, data },
  };
}
