#!/usr/bin/env node
import { runCli } from './run.js';

// `taskindex tasks --all | head -c 1`: the consumer closing the pipe is an
// ordinary end of output, not an error. Any durable outcome (outbox) is
// settled before a reply is printed, so leaving here loses nothing.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
process.exitCode = await runCli(process.argv.slice(2), {
  signal: controller.signal,
});
