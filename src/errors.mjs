export class AppError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage, options);
    this.name = "AppError";
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

export const MAX_STRUCTURED_DATA_BYTES = 1_000_000;
export const MAX_TOOL_SUMMARY_LENGTH = 500;

export function toSafeError(error) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.safeMessage };
  }
  return { code: "UPSTREAM_ERROR", message: "The directory or calendar service request failed." };
}

export function toolSuccess(data, summary) {
  const serializedData = JSON.stringify(data);
  if (Buffer.byteLength(serializedData, "utf8") > MAX_STRUCTURED_DATA_BYTES) {
    throw new AppError("RESULT_TOO_LARGE", "The result exceeded the safe response size limit.");
  }
  return {
    content: [{ type: "text", text: String(summary || "Completed.").slice(0, MAX_TOOL_SUMMARY_LENGTH) }],
    structuredContent: { ok: true, data },
  };
}

export function toolFailure(error) {
  const safe = toSafeError(error);
  return {
    isError: true,
    content: [{ type: "text", text: `${safe.code}: ${safe.message}` }],
    structuredContent: { ok: false, error: safe },
  };
}

