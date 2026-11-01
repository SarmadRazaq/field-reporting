/**
 * Command-line control of the server's fault injection.
 *
 *   npm run chaos                      show current state and presets
 *   npm run chaos -- preset flaky      apply a preset
 *   npm run chaos -- clear             remove every fault
 *   npm run chaos -- latency 1500      set latency (ms)
 *   npm run chaos -- bandwidth 4000    set throttle (bytes/s, 0 = off)
 *   npm run chaos -- rule chunk drop --after 65536 --rate 0.5 --times 3
 *   npm run chaos -- rule commit lose-response --times 1
 *   npm run chaos -- rule any error --status 503 --rate 0.2
 *   npm run chaos -- rule manifest refuse --status 413
 *   npm run chaos -- rule chunk hang --times 1
 *
 * SERVER=http://host:4000 overrides the target.
 */
const base = process.env.SERVER ?? 'http://localhost:4000';
const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  switch (cmd) {
    case undefined:
    case 'show':
      return call('GET', '/__chaos');
    case 'clear':
      return call('DELETE', '/__chaos');
    case 'preset':
      return call('POST', `/__chaos/preset/${rest[0]}`);
    case 'latency':
      return call('PUT', '/__chaos', { latencyMs: Number(rest[0]) });
    case 'bandwidth':
      return call('PUT', '/__chaos', { bandwidthBytesPerSec: Number(rest[0]) });
    case 'rule': {
      const [route, kind] = rest;
      const status = flag('status') ? Number(flag('status')) : undefined;
      const fault =
        kind === 'error' ? { kind, status: status ?? 503 }
        : kind === 'refuse' ? { kind, status: status ?? 413 }
        : kind === 'drop' ? { kind, afterBytes: flag('after') ? Number(flag('after')) : undefined }
        : { kind };
      return call('POST', '/__chaos/rules', {
        route,
        fault,
        rate: flag('rate') ? Number(flag('rate')) : 1,
        remaining: flag('times') ? Number(flag('times')) : null,
      });
    }
    case 'unrule':
      return call('DELETE', `/__chaos/rules/${rest[0]}`);
    default:
      throw new Error(`Unknown command "${cmd}". See the header of scripts/chaos.ts.`);
  }
}

main().then(
  out => console.log(JSON.stringify(out, null, 2)),
  err => {
    console.error(String(err));
    process.exit(1);
  },
);
