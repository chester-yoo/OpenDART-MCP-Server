import { AsyncLocalStorage } from "node:async_hooks";
import { checkResponse, OpenDartNetworkError } from "./errors";

const BASE_URL = "https://opendart.fss.or.kr/api";
const DEFAULT_TIMEOUT = 30000;
const BINARY_TIMEOUT = 55000;
const DEFAULT_RETRIES = 2;
const BINARY_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

/**
 * API 키는 요청 단위로만 보관한다.
 *
 * 이 서버는 stateless(요청마다 새 MCP 서버)로 Vercel 서버리스에서 돈다. 예전처럼 모듈 전역 변수에 키를 저장하면
 * 같은 인스턴스를 쓰는 다른 사용자의 요청에도 그 키가 쓰인다. 그래서 커넥터 URL의 ?opendart_key= 는
 * AsyncLocalStorage 로 해당 HTTP 요청 안에서만 보이게 한다.
 */
const requestContext = new AsyncLocalStorage<{ apiKey?: string }>();

export function runWithRequestApiKey<T>(apiKey: string | undefined, fn: () => T): T {
  return requestContext.run({ apiKey: apiKey || undefined }, fn);
}

export function getRequestApiKey(): string | undefined {
  return requestContext.getStore()?.apiKey;
}

export function resolveApiKey(toolParamKey?: string): string {
  const key = toolParamKey || getRequestApiKey() || process.env.OPENDART_API_KEY;
  if (!key) {
    throw new Error(
      "[OpenDART] API key required. Add ?opendart_key=YOUR_KEY to the connector URL or pass api_key. " +
      "Get one at https://opendart.fss.or.kr/ / " +
      "API 키가 필요합니다. 커넥터 URL에 ?opendart_key=본인키 를 붙이거나 도구의 api_key 인자로 넘기세요. " +
      "키는 https://opendart.fss.or.kr/ 에서 무료로 발급받을 수 있습니다."
    );
  }
  return key;
}

interface FetchOptions {
  timeout?: number;
  retries?: number;
  endpoint?: string;
}

async function fetchWithRetry(
  url: string,
  options: FetchOptions = {}
): Promise<Response> {
  const { timeout = DEFAULT_TIMEOUT, retries = DEFAULT_RETRIES, endpoint = "unknown" } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      if (response.status === 429 || response.status >= 500) {
        lastError = new OpenDartNetworkError("http", endpoint, attempt + 1, retries + 1, response.status);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
          continue;
        }
      }
      return response;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        lastError = new OpenDartNetworkError("timeout", endpoint, attempt + 1, retries + 1);
      } else if (err instanceof TypeError) {
        lastError = new OpenDartNetworkError("network", endpoint, attempt + 1, retries + 1);
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }
  throw lastError || new Error("Request failed after retries");
}

export async function getJson(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string
): Promise<Record<string, unknown>> {
  const url = new URL(`${BASE_URL}/${endpoint}.json`);
  url.searchParams.set("crtfc_key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }

  const response = await fetchWithRetry(url.toString(), {
    timeout: DEFAULT_TIMEOUT,
    retries: DEFAULT_RETRIES,
    endpoint,
  });
  if (!response.ok) {
    throw new OpenDartNetworkError("http", endpoint, 1, 1, response.status);
  }

  const data = await response.json() as { status: string; message: string; [key: string]: unknown };
  checkResponse(data, endpoint);
  return data;
}

export async function getBinary(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string
): Promise<ArrayBuffer> {
  const url = new URL(`${BASE_URL}/${endpoint}.xml`);
  url.searchParams.set("crtfc_key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }

  const response = await fetchWithRetry(url.toString(), {
    timeout: BINARY_TIMEOUT,
    retries: BINARY_RETRIES,
    endpoint,
  });
  if (!response.ok) {
    throw new OpenDartNetworkError("http", endpoint, 1, 1, response.status);
  }

  return response.arrayBuffer();
}
