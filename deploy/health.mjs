// @ts-check
// Единственная проба /health для образа, compose healthcheck, deploy.sh, rollback.sh
// и drill. Только node: API; тело ответа наружу не печатается без --print.
//   node deploy/health.mjs [--url URL] [--expect key=value ...] [--print] [--timeout MS]
// Код 0: ответ 2xx, тело — JSON с ok:true и все ожидания совпали; иначе код 1.
// Значения ожиданий: true/false → boolean, целое число → number, остальное — строка.
const args = process.argv.slice(2);
let url = 'http://127.0.0.1:3000/health';
let print = false;
let timeout = 5000;
/** @type {Record<string, string | number | boolean>} */
const expected = { ok: true };
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--url') url = args[++i] ?? url;
  else if (arg === '--print') print = true;
  else if (arg === '--timeout') timeout = Number(args[++i] ?? timeout);
  else if (arg === '--expect') {
    while (i + 1 < args.length && !args[i + 1]?.startsWith('--')) {
      const pair = args[++i] ?? '';
      const at = pair.indexOf('=');
      if (at < 1) {
        process.stderr.write(
          `health.mjs: expectation must be key=value: ${pair}\n`,
        );
        process.exit(2);
      }
      const key = pair.slice(0, at);
      const raw = pair.slice(at + 1);
      expected[key] =
        raw === 'true'
          ? true
          : raw === 'false'
            ? false
            : /^-?\d+$/.test(raw)
              ? Number(raw)
              : raw;
    }
  } else {
    process.stderr.write(`health.mjs: unknown argument ${arg}\n`);
    process.exit(2);
  }
}
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  /** @type {Record<string, unknown>} */
  const body = await response.json();
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => body[key] !== value)
    .map(
      ([key, value]) =>
        `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(body[key])}`,
    );
  if (!response.ok) mismatches.unshift(`http status ${response.status}`);
  if (print) process.stdout.write(`${JSON.stringify(body)}\n`);
  if (mismatches.length) {
    if (!print) process.stderr.write(`health.mjs: ${mismatches.join('; ')}\n`);
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(
    `health.mjs: ${url}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
