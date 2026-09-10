#!/usr/bin/env node
// Неиспользуемые экспорты `src/**` (TI-071, план 10, шаг 18). `tsc` их не
// видит: `noUnusedLocals` молчит про экспортированное имя, которое никто не
// импортирует. Здесь разбор идёт компилятором TypeScript из node_modules,
// новых зависимостей нет.
//
//   node scripts/unused-exports.mjs [--json]
//
// Имя попадает в отчёт в одной из двух групп:
//   dead       — не импортируется ни из `src`, ни из тестов и скриптов: удалять;
//   tests-only — нужен только тестам и скриптам: пометить `/** @internal for tests */`.
// Точки входа (`src/cli/index.ts`, `src/server/index.ts`, `src/web/main.tsx`),
// реэкспорты `export * from` и `export default` не считаются мёртвыми.
// Сгенерированные примитивы (`src/web/ui/**`, `src/web/vendor/**`) не
// проверяются: их обновляет генератор целиком.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const SOURCES = ['src'];
const CONSUMERS = ['src', 'tests', 'scripts', 'deploy'];
const ENTRY_POINTS = new Set(
  ['src/cli/index.ts', 'src/server/index.ts', 'src/web/main.tsx'].map((file) =>
    join(root, file),
  ),
);
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx'];
// Сгенерированные примитивы shadcn и вендорная копия: обновляются целиком
// командой генератора, поэтому их неиспользуемые экспорты не считаются долгом.
const GENERATED = ['src/web/ui/', 'src/web/vendor/'];

function walk(directory, files = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.'))
        walk(full, files);
    } else if (EXTENSIONS.some((extension) => entry.name.endsWith(extension)))
      files.push(full);
  }
  return files;
}

const parse = (file) =>
  ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') || file.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  );

// `./x.js` в исходниках указывает на `./x.ts`: путь разрешается по файлам,
// как это делает сборка, иначе ни один импорт не совпал бы с файлом.
function resolveSpecifier(from, specifier) {
  if (!specifier.startsWith('.')) {
    if (!specifier.startsWith('@shared/') && !specifier.startsWith('@/'))
      return undefined;
    specifier = specifier.startsWith('@shared/')
      ? join(root, 'src/shared', specifier.slice('@shared/'.length))
      : join(root, 'src/web', specifier.slice('@/'.length));
  } else specifier = resolve(dirname(from), specifier);
  const base = specifier.replace(/\.(js|jsx|mjs)$/, '');
  const candidates = [
    ...EXTENSIONS.map((extension) => `${base}${extension}`),
    specifier,
    ...EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  for (const candidate of candidates)
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Следующий кандидат.
    }
  return undefined;
}

// Тип или значение: удаление типа безопасно всегда, значение может быть
// частью публичной поверхности модуля, поэтому группы в отчёте разные.
function isTypeOnly(node) {
  return (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) ??
      false)
  );
}

function exportedNames(source) {
  const names = new Map();
  let starReexport = false;
  const add = (name, kind = 'value') => {
    if (name && name !== 'default') names.set(name, kind);
  };
  const isExported = (node) =>
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const node of source.statements) {
    if (ts.isExportDeclaration(node)) {
      if (!node.exportClause) starReexport = true;
      else if (ts.isNamedExports(node.exportClause))
        for (const element of node.exportClause.elements)
          add(
            element.name.text,
            node.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
          );
      continue;
    }
    if (!isExported(node)) continue;
    if (ts.isVariableStatement(node))
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) add(declaration.name.text);
        else
          for (const element of declaration.name.elements ?? [])
            if (element.name && ts.isIdentifier(element.name))
              add(element.name.text);
      }
    else if (node.name && ts.isIdentifier(node.name))
      add(node.name.text, isTypeOnly(node) ? 'type' : 'value');
  }
  return { names, starReexport };
}

// Что файл берёт у соседа: именованные импорты, `import * as`, реэкспорты.
function importsOf(source, file) {
  const used = new Map();
  const record = (specifier, names, all = false) => {
    const target = resolveSpecifier(file, specifier);
    if (!target) return;
    const entry = used.get(target) ?? { names: new Set(), all: false };
    for (const name of names) entry.names.add(name);
    entry.all ||= all;
    used.set(target, entry);
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (!clause) record(specifier, [], true);
        else if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings))
            record(specifier, [], true);
          else
            record(
              specifier,
              clause.namedBindings.elements.map(
                (element) => (element.propertyName ?? element.name).text,
              ),
            );
        } else record(specifier, []);
      } else if (!node.exportClause) record(specifier, [], true);
      else if (ts.isNamedExports(node.exportClause))
        record(
          specifier,
          node.exportClause.elements.map(
            (element) => (element.propertyName ?? element.name).text,
          ),
        );
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      record(node.arguments[0].text, [], true);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return used;
}

const sourceFiles = SOURCES.flatMap((directory) => walk(join(root, directory)));
const consumerFiles = CONSUMERS.flatMap((directory) =>
  walk(join(root, directory)),
);
// Кто и что берёт: по файлу-цели множество имён отдельно для `src` и для
// тестов и скриптов, плюс флаг «взят целиком» (namespace, `export *`).
const fromSource = new Map();
const fromTests = new Map();
for (const file of consumerFiles) {
  const inSource = file.startsWith(join(root, 'src') + '/');
  const bucket = inSource ? fromSource : fromTests;
  for (const [target, entry] of importsOf(parse(file), file)) {
    if (target === file) continue;
    const known = bucket.get(target) ?? { names: new Set(), all: false };
    for (const name of entry.names) known.names.add(name);
    known.all ||= entry.all;
    bucket.set(target, known);
  }
}

const dead = [];
const testsOnly = [];
for (const file of sourceFiles) {
  if (ENTRY_POINTS.has(file)) continue;
  const { names, starReexport } = exportedNames(parse(file));
  if (starReexport || !names.size) continue;
  const relativePath = relative(root, file);
  if (GENERATED.some((prefix) => relativePath.startsWith(prefix))) continue;
  const source = fromSource.get(file);
  const tests = fromTests.get(file);
  if (source?.all) continue;
  for (const [name, kind] of [...names].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (source?.names.has(name)) continue;
    const entry = { file: relativePath, name, kind };
    if (tests?.all || tests?.names.has(name)) testsOnly.push(entry);
    else dead.push(entry);
  }
}

const area = (entry) => entry.file.split('/')[1] ?? '';
if (process.argv.includes('--json'))
  process.stdout.write(`${JSON.stringify({ dead, testsOnly }, null, 2)}\n`);
else {
  const print = (title, list) => {
    process.stdout.write(`${title}: ${list.length}\n`);
    for (const entry of list)
      process.stdout.write(
        `  ${entry.file}:${entry.name}${entry.kind === 'type' ? ' (тип)' : ''}\n`,
      );
  };
  print('Мёртвые экспорты (никто не импортирует)', dead);
  print('Только для тестов и скриптов (пометить @internal)', testsOnly);
  const byArea = {};
  for (const entry of dead)
    byArea[area(entry)] = (byArea[area(entry)] ?? 0) + 1;
  process.stdout.write(
    `По областям: ${JSON.stringify(byArea)}; всего мёртвых ${dead.length}\n`,
  );
}
process.exitCode = dead.length ? 1 : 0;
