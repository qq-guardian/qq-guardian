/**
 * HTTP surface required by Guardian's API and WebUI registration.
 *
 * This is deliberately independent from NapCat. Native NapCat routers and the
 * standalone SnowLuma router both implement this structural contract.
 */
export type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'all';

export interface GuardianHttpRequest {
  path: string;
  method: string;
  query: Record<string, string | string[] | undefined>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  raw: unknown;
}

export interface GuardianHttpResponse {
  status(code: number): GuardianHttpResponse;
  json(data: unknown): void;
  send(data: string | Buffer): void;
  setHeader(name: string, value: string): GuardianHttpResponse;
  sendFile(filePath: string): void;
  redirect(url: string): void;
  raw: unknown;
}

export type GuardianNextFunction = (err?: unknown) => void;
export type GuardianRequestHandler = (
  req: GuardianHttpRequest,
  res: GuardianHttpResponse,
  next: GuardianNextFunction,
) => void | Promise<void>;

export interface GuardianPageDefinition {
  path: string;
  title: string;
  icon?: string;
  htmlFile: string;
  description?: string;
}

export interface MemoryStaticFile {
  path: string;
  content: string | Buffer | (() => string | Buffer | Promise<string | Buffer>);
  contentType?: string;
}

export interface GuardianHttpRouter {
  api(method: HttpMethod, path: string, handler: GuardianRequestHandler): void;
  get(path: string, handler: GuardianRequestHandler): void;
  post(path: string, handler: GuardianRequestHandler): void;
  put(path: string, handler: GuardianRequestHandler): void;
  delete(path: string, handler: GuardianRequestHandler): void;
  apiNoAuth(method: HttpMethod, path: string, handler: GuardianRequestHandler): void;
  getNoAuth(path: string, handler: GuardianRequestHandler): void;
  postNoAuth(path: string, handler: GuardianRequestHandler): void;
  putNoAuth(path: string, handler: GuardianRequestHandler): void;
  deleteNoAuth(path: string, handler: GuardianRequestHandler): void;
  static(urlPath: string, localPath: string): void;
  staticOnMem(urlPath: string, files: MemoryStaticFile[]): void;
  page(page: GuardianPageDefinition): void;
  pages(pages: GuardianPageDefinition[]): void;
}
