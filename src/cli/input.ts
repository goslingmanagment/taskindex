import { readFile } from 'node:fs/promises';

export async function readInput(path: string): Promise<string> {
  if (path !== '-') return readFile(path, 'utf8');
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}
