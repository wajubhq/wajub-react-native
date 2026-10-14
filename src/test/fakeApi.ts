/**
 * A fake `/pay/*` for the tests: each route answers with a spec fixture
 * (its `http_status`, `body` and `response_headers`), in order, the last
 * answer repeating. No request leaves the process.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

export interface Fixture {
  request?: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown };
  http_status: number;
  body: unknown;
  response_headers?: Record<string, string>;
  /** Realtime fixtures carry the event payload here. */
  data?: unknown;
  event?: string;
  channel?: string;
}

export const FIXTURES_DIR = join(__dirname, '..', '__fixtures__');

export function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name.replace(/\.json$/, '')}.json`), 'utf8')) as Fixture;
}

/** A fixture's body, as a mutable copy. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function body(name: string): any {
  return JSON.parse(JSON.stringify(fixture(name).body));
}

/**
 * A fixture name; an explicit answer; `network` (no answer); `hang` (an
 * answer that never comes, until the request is aborted); or a function of
 * the request.
 */
export type Answer =
  | string
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | 'network'
  | 'hang'
  | ((call: Call) => Answer);

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  /** The raw request body, as sent. */
  raw: string | undefined;
}

export interface FakeApi {
  fetch: jest.Mock;
  calls: Call[];
  /** Calls to "GET /pay/session", "POST /pay/process"… */
  callsTo(route: string): Call[];
  /** Replace the answers of one route. */
  answer(route: string, answers: Answer | Answer[]): void;
  restore(): void;
}

function respond(answer: Answer, call: Call, signal?: AbortSignal | null): Promise<unknown> {
  if (typeof answer === 'function') return respond(answer(call), call, signal);
  if (answer === 'network') return Promise.reject(new TypeError('Network request failed'));
  if (answer === 'hang') {
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('Aborted')));
    });
  }
  const { status, body: payload, headers } =
    typeof answer === 'string'
      ? (() => {
          const f = fixture(answer);
          return { status: f.http_status, body: f.body, headers: f.response_headers };
        })()
      : answer;
  const all: Record<string, string> = { ...(headers ?? {}) };
  const requestId = call.headers['X-Request-Id'];
  if (requestId && requestId.length <= 64) all['X-Request-Id'] = requestId;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => Object.entries(all).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null,
    },
    text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
  });
}

/** Installs itself as `global.fetch`; `restore()` puts the previous one back. */
export function fakeApi(routes: Record<string, Answer | Answer[]>): FakeApi {
  const queues = new Map<string, Answer[]>(Object.entries(routes).map(([route, a]) => [route, Array.isArray(a) ? [...a] : [a]]));
  const calls: Call[] = [];
  const previous = global.fetch;
  const fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const path = new URL(url).pathname;
    const raw = typeof init.body === 'string' ? init.body : undefined;
    const call: Call = { method, path, headers: { ...(init.headers as Record<string, string>) }, body: raw ? JSON.parse(raw) : undefined, raw };
    calls.push(call);
    const queue = queues.get(`${method} ${path}`);
    if (!queue || queue.length === 0) {
      return respond({ status: 404, body: { code: 404, status: 'Not Found', message: `No fake for ${method} ${path}` } }, call);
    }
    const answer = queue.length > 1 ? queue.shift()! : queue[0];
    return respond(answer, call, init.signal);
  });
  global.fetch = fetch as unknown as typeof global.fetch;
  return {
    fetch,
    calls,
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
    answer: (route, answers) => queues.set(route, Array.isArray(answers) ? [...answers] : [answers]),
    restore: () => {
      global.fetch = previous;
    },
  };
}

/** Lets pending promises (and zero-delay timers, under fake timers) run. */
export async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    if ('clock' in setTimeout) await jest.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setImmediate(resolve));
  }
}
