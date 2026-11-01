import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Which part of the protocol a request belongs to. Rules target these. */
export const ROUTE_TAGS = ['manifest', 'offset', 'chunk', 'commit', 'list', 'image', 'reset'] as const;
export type RouteTag = (typeof ROUTE_TAGS)[number];

export type Fault =
  /** Reply with a (usually retryable) error status. */
  | { kind: 'error'; status: number }
  /** Accept the request and never answer. */
  | { kind: 'hang' }
  /** Kill the TCP connection. On chunk uploads, optionally after N body bytes. */
  | { kind: 'drop'; afterBytes?: number }
  /** Refuse the request permanently (403 / 413 / 422). */
  | { kind: 'refuse'; status: 403 | 413 | 422 }
  /** Do the work, then kill the connection instead of replying. */
  | { kind: 'lose-response' };

export interface Rule {
  id: string;
  route: RouteTag | 'any';
  fault: Fault;
  /** Probability per matching request, 0..1. */
  rate: number;
  /** How many more times it may fire; null means forever. */
  remaining: number | null;
}

export interface ChaosState {
  latencyMs: number;
  /** Throttle for upload and image bodies; 0 disables. */
  bandwidthBytesPerSec: number;
  rules: Rule[];
}

export type RuleInput = Omit<Rule, 'id' | 'remaining' | 'rate'> & { rate?: number; remaining?: number | null };

const EMPTY: ChaosState = { latencyMs: 0, bandwidthBytesPerSec: 0, rules: [] };

/** Named setups, so a grader can break things without composing JSON. */
export const PRESETS: Record<string, { describe: string; state: Omit<ChaosState, 'rules'> & { rules: RuleInput[] } }> = {
  clear: { describe: 'No faults, full speed', state: { ...EMPTY } },
  '2g': {
    describe: 'About 2G: 600 ms latency, about 6 KB/s',
    state: { latencyMs: 600, bandwidthBytesPerSec: 6_000, rules: [] },
  },
  flaky: {
    describe: '2G plus 25% of chunks dropped mid-body and 10% of requests 503',
    state: {
      latencyMs: 600,
      bandwidthBytesPerSec: 6_000,
      rules: [
        { route: 'chunk', fault: { kind: 'drop', afterBytes: 64 * 1024 }, rate: 0.25 },
        { route: 'any', fault: { kind: 'error', status: 503 }, rate: 0.1 },
      ],
    },
  },
  'errors-500': {
    describe: 'Half of all requests answer 500 (retryable)',
    state: { ...EMPTY, rules: [{ route: 'any', fault: { kind: 'error', status: 500 }, rate: 0.5 }] },
  },
  'hang-next-chunk': {
    describe: 'The next chunk upload is accepted and never answered',
    state: { ...EMPTY, rules: [{ route: 'chunk', fault: { kind: 'hang' }, remaining: 1 }] },
  },
  'drop-next-2-chunks': {
    describe: 'The next two chunk uploads lose their connection halfway',
    state: { ...EMPTY, rules: [{ route: 'chunk', fault: { kind: 'drop', afterBytes: 100 * 1024 }, remaining: 2 }] },
  },
  'lose-next-commit': {
    describe: 'The next commit succeeds on the server but the reply is lost',
    state: { ...EMPTY, rules: [{ route: 'commit', fault: { kind: 'lose-response' }, remaining: 1 }] },
  },
  'refuse-uploads': {
    describe: 'Every new report is refused with 413 (permanent; must not be retried)',
    state: { ...EMPTY, rules: [{ route: 'manifest', fault: { kind: 'refuse', status: 413 } }] },
  },
  'forbid-uploads': {
    describe: 'Every new report is refused with 403 (permanent; must not be retried)',
    state: { ...EMPTY, rules: [{ route: 'manifest', fault: { kind: 'refuse', status: 403 } }] },
  },
};

export interface ChaosLocals {
  dropAfterBytes?: number;
}

export class Chaos {
  private state: ChaosState = structuredClone(EMPTY);
  private hung = new Set<Response>();
  constructor(private readonly random: () => number = Math.random, private readonly log = console.log) {}

  get(): ChaosState {
    return structuredClone(this.state);
  }

  bandwidth(): number {
    return this.state.bandwidthBytesPerSec;
  }

  configure(patch: Partial<Pick<ChaosState, 'latencyMs' | 'bandwidthBytesPerSec'>>) {
    if (patch.latencyMs !== undefined) this.state.latencyMs = Math.max(0, Number(patch.latencyMs) || 0);
    if (patch.bandwidthBytesPerSec !== undefined)
      this.state.bandwidthBytesPerSec = Math.max(0, Number(patch.bandwidthBytesPerSec) || 0);
  }

  addRule(input: RuleInput): Rule {
    const rule: Rule = {
      id: randomUUID().slice(0, 8),
      route: input.route,
      fault: input.fault,
      rate: Math.min(1, Math.max(0, input.rate ?? 1)),
      remaining: input.remaining ?? null,
    };
    this.state.rules.push(rule);
    return rule;
  }

  removeRule(id: string) {
    this.state.rules = this.state.rules.filter(r => r.id !== id);
  }

  /** Clear every fault, and release any requests currently being held open. */
  clear() {
    this.state = structuredClone(EMPTY);
    for (const res of this.hung) res.socket?.destroy();
    this.hung.clear();
  }

  applyPreset(name: string): boolean {
    const preset = PRESETS[name];
    if (!preset) return false;
    this.clear();
    this.configure(preset.state);
    for (const rule of preset.state.rules) this.addRule(rule);
    return true;
  }

  /** Picks the fault (if any) that fires for this request, consuming one-shot rules. */
  pick(tag: RouteTag): Fault | undefined {
    for (const rule of this.state.rules) {
      if (rule.route !== 'any' && rule.route !== tag) continue;
      if (this.random() >= rule.rate) continue;
      if (rule.remaining !== null) {
        rule.remaining -= 1;
        if (rule.remaining <= 0) this.removeRule(rule.id);
      }
      return rule.fault;
    }
    return undefined;
  }

  /** Express middleware placed in front of each protocol route. */
  gate(tag: RouteTag) {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (this.state.latencyMs > 0) await sleep(this.state.latencyMs);
      const fault = this.pick(tag);
      if (!fault) return next();
      this.log(`[chaos] ${tag} ${req.method} ${req.path} → ${describeFault(fault)}`);
      switch (fault.kind) {
        case 'error':
          res.status(fault.status).json({ code: 'chaos_error', message: `Injected ${fault.status}` });
          return;
        case 'refuse':
          res.status(fault.status).json({
            code: fault.status === 413 ? 'too_large' : fault.status === 403 ? 'forbidden' : 'unprocessable',
            message: `Refused by chaos rule (${fault.status})`,
          });
          return;
        case 'hang':
          this.hung.add(res);
          res.on('close', () => this.hung.delete(res));
          return; // never answer
        case 'drop':
          if (tag === 'chunk' && fault.afterBytes) {
            (res.locals as ChaosLocals).dropAfterBytes = fault.afterBytes;
            return next();
          }
          req.socket.destroy();
          return;
        case 'lose-response': {
          const socket = req.socket;
          res.end = (() => {
            socket.destroy();
            return res;
          }) as typeof res.end;
          return next();
        }
      }
    };
  }
}

export function describeFault(f: Fault): string {
  switch (f.kind) {
    case 'error':
      return `error ${f.status}`;
    case 'refuse':
      return `refuse ${f.status}`;
    case 'hang':
      return 'hang';
    case 'drop':
      return f.afterBytes ? `drop after ${f.afterBytes} B` : 'drop';
    case 'lose-response':
      return 'lose response';
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
