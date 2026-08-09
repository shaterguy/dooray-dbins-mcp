import { DoorayApiError } from "./client.mjs";

function jsonText(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated: increase DOORAY_MAX_TOOL_TEXT_CHARS or narrow the query]`;
}

export function successResult(value: unknown, maxChars: number) {
  return {
    content: [{ type: "text" as const, text: jsonText(value, maxChars) }],
    structuredContent: { data: value },
  };
}

export function errorResult(error: unknown) {
  const message = error instanceof DoorayApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : "Unknown Dooray MCP error.";
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}
