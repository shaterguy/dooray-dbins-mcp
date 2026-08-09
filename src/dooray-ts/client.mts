import { request as httpsRequest } from "node:https";
import { buildDoorayUrl } from "./guards.mjs";
import type { DoorayClientOptions, DoorayEnvelope, DoorayQuery } from "./types.mjs";

export class DoorayApiError extends Error {
  readonly status?: number;
  readonly resultCode?: number | string;
  readonly authenticationFailure: boolean;
  readonly transport?: string;

  constructor(
    message: string,
    options: {
      status?: number;
      resultCode?: number | string;
      authenticationFailure?: boolean;
      transport?: string;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "DoorayApiError";
    this.status = options.status;
    this.resultCode = options.resultCode;
    this.authenticationFailure = options.authenticationFailure ?? false;
    this.transport = options.transport;
  }
}

type HttpsRequestImpl = (
  url: URL,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number
) => Promise<Response>;

interface RequestAttempt {
  name: string;
  execute: () => Promise<Response>;
}

function isAuthenticationFailure(
  message: string,
  status?: number,
  resultCode?: number | string
): boolean {
  const normalizedCode = String(resultCode ?? "").toLowerCase();
  return (
    status === 401 ||
    status === 403 ||
    normalizedCode === "401" ||
    normalizedCode === "403" ||
    /authoriz|authentication|credential|invalid\s+(?:api\s+)?(?:key|token)|expired\s+(?:api\s+)?(?:key|token)/i.test(
      message
    )
  );
}

function appendSafeAuthDiagnostics(
  message: string,
  options: DoorayClientOptions,
  attemptedTransports: readonly string[]
): string {
  return `${message} [MCP diagnostics: apiHost=${options.baseUrl.hostname}; normalizedTokenLength=${options.token.length}; authAttempts=${attemptedTransports.join(",")}; allRejected=true]`;
}

function toResponseHeaders(rawHeaders: Readonly<Record<string, string | string[] | undefined>>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

const defaultHttpsRequest: HttpsRequestImpl = (url, headers, timeoutMs) =>
  new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers,
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: Buffer | Uint8Array) => {
          chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
          resolve(
            new Response(body, {
              status: response.statusCode || 502,
              headers: toResponseHeaders(response.headers),
            })
          );
        });
        response.on("error", reject);
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Dooray HTTPS request timed out after ${timeoutMs} ms.`));
    });
    request.on("error", reject);
    request.end();
  });

export class DoorayClient {
  private readonly options: DoorayClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly httpsRequestImpl: HttpsRequestImpl;

  constructor(
    options: DoorayClientOptions,
    fetchImpl: typeof fetch = fetch,
    httpsRequestImpl: HttpsRequestImpl = defaultHttpsRequest
  ) {
    this.options = options;
    this.fetchImpl = fetchImpl;
    this.httpsRequestImpl = httpsRequestImpl;
  }

  private standardHeaders(): Record<string, string> {
    return {
      Accept: "application/json, text/plain;q=0.8",
      Authorization: `dooray-api ${this.options.token}`,
      "User-Agent": this.options.userAgent || "dooray-readonly-mcp/0.1.0",
    };
  }

  private existingMcpHeaders(): Record<string, string> {
    return {
      Authorization: `dooray-api ${this.options.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async fetchResponse(url: URL, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new DoorayApiError(
          `Dooray API request timed out after ${this.options.timeoutMs} ms.`,
          { cause: error }
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseResponse<T>(response: Response, transport: string): Promise<T> {
    const contentLength = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > this.options.maxResponseBytes) {
      throw new DoorayApiError("Dooray response exceeded the configured size limit.", {
        status: response.status,
        transport,
      });
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.options.maxResponseBytes) {
      throw new DoorayApiError("Dooray response exceeded the configured size limit.", {
        status: response.status,
        transport,
      });
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const text = new TextDecoder().decode(bytes);
    let parsed: unknown;

    if (
      contentType.includes("application/json") ||
      text.trim().startsWith("{") ||
      text.trim().startsWith("[")
    ) {
      try {
        parsed = text.length ? JSON.parse(text) : null;
      } catch (error) {
        throw new DoorayApiError("Dooray returned invalid JSON.", {
          status: response.status,
          transport,
          cause: error,
        });
      }
    } else if (contentType.startsWith("text/")) {
      parsed = text;
    } else {
      throw new DoorayApiError(
        "Binary Dooray responses are not exposed by this read-only MCP server.",
        { status: response.status, transport }
      );
    }

    const envelope = parsed as DoorayEnvelope | null;
    const apiFailed = Boolean(envelope?.header && envelope.header.isSuccessful === false);
    if (!response.ok || apiFailed) {
      const rawMessage =
        envelope?.header?.resultMessage ||
        `Dooray API request failed with HTTP ${response.status}.`;
      const resultCode = envelope?.header?.resultCode;
      throw new DoorayApiError(rawMessage, {
        status: response.status,
        resultCode,
        authenticationFailure: isAuthenticationFailure(rawMessage, response.status, resultCode),
        transport,
      });
    }

    return parsed as T;
  }

  async get<T = unknown>(path: string, query: DoorayQuery = {}): Promise<T> {
    const url = buildDoorayUrl(this.options.baseUrl, this.options.allowedHosts, path, query);
    const compatibleHeaders = this.existingMcpHeaders();
    const attempts: RequestAttempt[] = [
      {
        name: "fetch-standard",
        execute: () => this.fetchResponse(url, this.standardHeaders()),
      },
      {
        name: "fetch-existing-mcp-headers",
        execute: () => this.fetchResponse(url, compatibleHeaders),
      },
      {
        name: "node-https-existing-mcp-headers",
        execute: () => this.httpsRequestImpl(url, compatibleHeaders, this.options.timeoutMs),
      },
    ];

    const attemptedTransports: string[] = [];
    let lastAuthenticationError: DoorayApiError | undefined;

    for (const attempt of attempts) {
      attemptedTransports.push(attempt.name);
      try {
        const response = await attempt.execute();
        return await this.parseResponse<T>(response, attempt.name);
      } catch (error) {
        if (error instanceof DoorayApiError && error.authenticationFailure) {
          lastAuthenticationError = error;
          continue;
        }
        if (error instanceof DoorayApiError) throw error;
        throw new DoorayApiError(
          `Dooray API request failed before a valid response was received via ${attempt.name}.`,
          { transport: attempt.name, cause: error }
        );
      }
    }

    if (lastAuthenticationError) {
      throw new DoorayApiError(
        appendSafeAuthDiagnostics(
          lastAuthenticationError.message,
          this.options,
          attemptedTransports
        ),
        {
          status: lastAuthenticationError.status,
          resultCode: lastAuthenticationError.resultCode,
          authenticationFailure: true,
          transport: lastAuthenticationError.transport,
          cause: lastAuthenticationError,
        }
      );
    }

    throw new DoorayApiError("Dooray API request failed without a response.");
  }
}
