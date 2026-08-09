export type DoorayQueryScalar = string | number | boolean;
export type DoorayQueryValue = DoorayQueryScalar | readonly DoorayQueryScalar[] | null | undefined;
export type DoorayQuery = Readonly<Record<string, DoorayQueryValue>>;

export interface DoorayResponseHeader {
  isSuccessful?: boolean;
  resultCode?: number | string;
  resultMessage?: string;
}

export interface DoorayEnvelope<T = unknown> {
  header?: DoorayResponseHeader;
  result?: T;
  totalCount?: number;
  [key: string]: unknown;
}

export interface DoorayRequestTarget {
  path: string;
  query?: DoorayQuery;
}

export interface DoorayClientOptions {
  token: string;
  baseUrl: URL;
  allowedHosts: ReadonlySet<string>;
  timeoutMs: number;
  maxResponseBytes: number;
  userAgent?: string;
}

