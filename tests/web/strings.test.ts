import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// TI-030: every user-facing string of the web client is Russian. This is a
// source inventory, not a translation system: it collects visible JSX text,
// accessible names (aria-label, title, placeholder, sr-only text) and toast
// titles, and fails on Latin words outside the explicit allow list below.
const ROOT = join(import.meta.dirname, '../../src/web');
// Product name, protocol words and key names appear inside Russian phrases.
const ALLOWED_WORDS = new Set([
  'TaskIndex',
  'passkey',
  'Passkey',
  'N',
  'Esc',
  'Enter',
  'Ctrl',
  'Shift',
  'Alt',
  'Cmd',
  'Tab',
  'Tailwind',
]);
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
function lineOf(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}
// Candidate texts that reach the user: attribute values, sr-only text, JSX
// text nodes and toast titles/descriptions. Class-name strings are skipped by
// construction (only these attributes and text positions are collected).
const CANDIDATES: { name: string; pattern: RegExp }[] = [
  {
    name: 'attribute',
    pattern:
      /\b(?:aria-label|aria-description|title|placeholder|alt)=(?:"([^"]*)"|'([^']*)'|\{'([^']*)'\}|\{"([^"]*)"\})/g,
  },
  { name: 'sr-only', pattern: /className="sr-only"\s*>\s*([^<{]+?)\s*</g },
  { name: 'toast', pattern: /\b(?:title|description):\s*'([^']*)'/g },
  // JSX text: a capitalized Latin word (optionally followed by lowercase
  // words) sitting directly between tags.
  {
    name: 'jsx-text',
    pattern: /(?<!=)>\s*([A-Z][a-z]{2,}(?:[ ,.]+[a-z]+)*\.?)\s*</g,
  },
];
function latinWords(text: string) {
  return (text.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).filter(
    (word) => !ALLOWED_WORDS.has(word),
  );
}
describe('TI-030 user-facing strings of src/web are Russian', () => {
  it('has no English attribute values, sr-only text, JSX text or toast titles', () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const source = readFileSync(file, 'utf8');
      for (const { name, pattern } of CANDIDATES) {
        for (const match of source.matchAll(pattern)) {
          const text =
            match.slice(1).find((group) => group !== undefined) ?? '';
          const words = latinWords(text);
          if (words.length === 0) continue;
          offenders.push(
            `${relative(ROOT, file)}:${lineOf(source, match.index)} [${name}] «${text.trim()}» → ${words.join(', ')}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
