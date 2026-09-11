#!/usr/bin/env node
// TI-025 (план 08, шаг 8): гейт скина. Проверяет, что ручной CSS остаётся
// скином: значения цвета живут только в tokens.css, каскад решается слоем,
// а не !important и не селекторами внутрь примитивов, и что контраст пар
// токенов проходит WCAG 2.2. Запускается из `npm run check`.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIN_DIR = 'src/web/skin';
const TOKENS = 'src/web/tokens.css';
const STYLES = 'src/web/styles.css';
const UI_DIR = 'src/web/ui';
const problems = [];
const fail = (file, line, message) =>
  problems.push(`${file}${line ? `:${line}` : ''} ${message}`);
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const skinFiles = readdirSync(SKIN_DIR)
  .filter((name) => name.endsWith('.css'))
  .sort();
const read = (path) => readFileSync(path, 'utf8');
// Комментарии заменяются пробелами той же длины: содержимое не проверяется,
// но номера строк остаются настоящими.
const bare = (css) =>
  css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));

// 1. Ни одного литерала цвета вне tokens.css.
const NAMED = new Set([
  'white',
  'black',
  'red',
  'green',
  'blue',
  'gray',
  'grey',
  'silver',
  'maroon',
  'olive',
  'lime',
  'aqua',
  'teal',
  'navy',
  'fuchsia',
  'purple',
  'yellow',
  'orange',
  'pink',
  'brown',
  'gold',
  'beige',
  'ivory',
  'khaki',
  'salmon',
  'coral',
  'crimson',
  'indigo',
  'violet',
  'tan',
  'plum',
  'orchid',
  'wheat',
]);
const COLOR_PROPERTY =
  /(^|[\s;{])(color|background|background-color|border|border-[a-z-]+|outline|outline-color|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration-color|column-rule-color)\s*:\s*([^;{}]*)/g;
for (const name of [...skinFiles.map((f) => join(SKIN_DIR, f)), STYLES]) {
  const css = bare(read(name));
  for (const hit of css.matchAll(
    /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab)\(/g,
  ))
    fail(
      name,
      lineOf(css, hit.index),
      `литерал цвета «${hit[0]}» вне ${TOKENS}`,
    );
  for (const declaration of css.matchAll(COLOR_PROPERTY))
    for (const word of declaration[3].match(/[a-z]+/g) ?? [])
      if (NAMED.has(word))
        fail(
          name,
          lineOf(css, declaration.index),
          `именованный цвет «${word}» вне ${TOKENS}`,
        );
}

// 2. !important только в блоке prefers-reduced-motion файла styles.css.
function blockRange(css, opener) {
  const start = css.indexOf(opener);
  if (start === -1) return null;
  let i = css.indexOf('{', start) + 1;
  let depth = 1;
  while (i < css.length && depth) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return [start, i];
}
for (const name of [...skinFiles.map((f) => join(SKIN_DIR, f)), STYLES]) {
  const css = bare(read(name));
  const allowed =
    name === STYLES ? blockRange(css, '@media (prefers-reduced-motion') : null;
  for (const hit of css.matchAll(/!important/g))
    if (!allowed || hit.index < allowed[0] || hit.index > allowed[1])
      fail(
        name,
        lineOf(css, hit.index),
        '!important вне prefers-reduced-motion',
      );
}

// Разбор правил: селектор, контекст (@media), тело.
function rules(css) {
  const out = [];
  let i = 0;
  const ctx = [];
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;
    if (css.startsWith('/*', i)) {
      i = css.indexOf('*/', i) + 2;
      continue;
    }
    if (css[i] === '}') {
      ctx.pop();
      i++;
      continue;
    }
    const start = i;
    while (i < css.length && !'{;}'.includes(css[i])) i++;
    if (css[i] === ';') {
      i++;
      continue;
    }
    const prelude = css.slice(start, i).trim().replace(/\s+/g, ' ');
    i++;
    if (prelude.startsWith('@')) {
      ctx.push(prelude);
      continue;
    }
    let depth = 1;
    const bodyStart = i;
    while (i < css.length && depth) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.push({
      prelude,
      context: ctx.filter((c) => !c.startsWith('@layer')).join(' | '),
      body: css.slice(bodyStart, i - 1),
      index: start,
    });
  }
  return out;
}

// 3. Селектор не встречается в двух файлах скина.
const homes = new Map();
for (const file of skinFiles) {
  const css = read(join(SKIN_DIR, file));
  for (const rule of rules(css))
    for (const part of rule.prelude
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const key = `${rule.context}||${part}`;
      const seen = homes.get(key) ?? new Set();
      seen.add(file);
      homes.set(key, seen);
    }
}
for (const [key, files] of homes)
  if (files.size > 1)
    fail(
      SKIN_DIR,
      0,
      `селектор «${key.split('||')[1]}» в двух файлах: ${[...files].join(', ')}`,
    );

// 4. Никаких селекторов элементов, которые рисуют примитивы, внутрь примитива.
// Собственная разметка приложения (h1..h6, p, span, div, li, label, form, svg,
// kbd, pre, small, details, summary, a, time, ol, ul, dd, dt) разрешена: эти
// элементы пишет сам экран, а не компонент из src/web/ui.
const PRIMITIVE_ELEMENTS = /(^|[\s>+~])(button|input|textarea|select)\b/;
for (const file of skinFiles) {
  const css = read(join(SKIN_DIR, file));
  for (const rule of rules(css))
    for (const part of rule.prelude
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!/^[.[]/.test(part)) continue;
      const rest = part.replace(/^[^\s>+~]+/, '');
      if (PRIMITIVE_ELEMENTS.test(rest))
        fail(
          join(SKIN_DIR, file),
          lineOf(css, rule.index),
          `селектор «${part}» достаёт до элемента внутри примитива; используйте [data-slot=…] или свой класс`,
        );
    }
}

// 5. data-slot, на которые опирается скин, объявлены в src/web/ui.
const declared = new Set();
for (const file of readdirSync(UI_DIR))
  for (const hit of read(join(UI_DIR, file)).matchAll(/data-slot="([a-z-]+)"/g))
    declared.add(hit[1]);
for (const file of skinFiles) {
  const css = read(join(SKIN_DIR, file));
  for (const hit of css.matchAll(/data-slot=['"]([a-z-]+)['"]/g))
    if (!declared.has(hit[1]))
      fail(
        join(SKIN_DIR, file),
        lineOf(css, hit.index),
        `слот «${hit[1]}» не объявлен в ${UI_DIR}`,
      );
}

// 6. Токены определяются только в tokens.css, по блоку на пару (скин, режим).
const ALLOWED_BLOCKS =
  /^(:root|\.dark|:root\[data-skin='[a-z0-9-]+'\]|:root\[data-skin='[a-z0-9-]+'\]\.dark|:root\[data-theme='[a-z]+'\]|@theme[a-z ]*|@media \(prefers-color-scheme: dark\)|:root:not\(\[data-theme='light'\]\))$/;
const tokensCss = read(TOKENS);
const definedIn = new Map();
for (const rule of rules(tokensCss)) {
  if (!ALLOWED_BLOCKS.test(rule.prelude))
    fail(
      TOKENS,
      lineOf(tokensCss, rule.index),
      `неожиданный блок «${rule.prelude}»`,
    );
  for (const hit of rule.body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) {
    const key = `${rule.context}||${rule.prelude}||${hit[1]}`;
    if (definedIn.has(key))
      fail(
        TOKENS,
        lineOf(tokensCss, rule.index),
        `токен ${hit[1]} определён дважды в одном блоке`,
      );
    definedIn.set(key, true);
  }
}
for (const name of [...skinFiles.map((f) => join(SKIN_DIR, f)), STYLES]) {
  const css = bare(read(name));
  for (const hit of css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm))
    fail(
      name,
      lineOf(css, hit.index),
      `токен ${hit[1]} определён вне ${TOKENS}`,
    );
}

// 7. Мёртвых классов в скине нет.
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? walk(path)
      : /\.tsx?$/.test(name)
        ? [path]
        : [];
  });
}
const words = new Set();
for (const file of walk('src/web'))
  for (const hit of read(file).matchAll(/[A-Za-z0-9_-]+/g)) words.add(hit[0]);
for (const file of skinFiles) {
  const css = read(join(SKIN_DIR, file));
  const seen = new Set();
  for (const hit of css.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g))
    if (!words.has(hit[1]) && !seen.has(hit[1])) {
      seen.add(hit[1]);
      fail(
        join(SKIN_DIR, file),
        lineOf(css, hit.index),
        `класс «${hit[1]}» не встречается в src/web/**`,
      );
    }
}

// 8. Контраст WCAG 2.2 по парам ролей (доп. шаг 13 плана 08).
const palette = new Map();
const darkBlocks = [];
for (const rule of rules(tokensCss)) {
  const dark =
    rule.prelude === ":root[data-theme='dark']" ||
    rule.prelude === ":root:not([data-theme='light'])";
  if (rule.prelude !== ':root' && !dark) continue;
  const values = new Map();
  for (const hit of rule.body.matchAll(
    /(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g,
  ))
    values.set(hit[1], hit[2]);
  if (dark) darkBlocks.push({ rule, values });
  for (const [name, value] of values)
    palette.set(`${dark ? 'dark' : 'light'}${name}`, value);
}
// Тёмная палитра объявлена дважды (явный выбор и системное предпочтение).
// Блоки обязаны совпадать: иначе одна из двух дорог покрасит интерфейс иначе.
if (darkBlocks.length !== 2)
  fail(
    TOKENS,
    0,
    `тёмных блоков ${darkBlocks.length}, ожидались два (data-theme и prefers-color-scheme)`,
  );
else {
  const [a, b] = darkBlocks;
  for (const name of new Set([...a.values.keys(), ...b.values.keys()]))
    if (a.values.get(name) !== b.values.get(name))
      fail(
        TOKENS,
        lineOf(tokensCss, b.rule.index),
        `тёмные блоки расходятся по ${name}: ${a.values.get(name) ?? '—'} и ${b.values.get(name) ?? '—'}`,
      );
}
function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  let body = hex.slice(1);
  if (body.length === 3 || body.length === 4)
    body = [...body].map((ch) => ch + ch).join('');
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(body.slice(at, at + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
// Пары «текст на фоне» и порог. Исключения — с причиной; фаза B сводит близкие
// оттенки и поднимает их выше порога (план 08, шаг 11).
const PAIRS = [
  ['--foreground', '--background', 4.5],
  ['--card-foreground', '--card', 4.5],
  ['--muted-foreground', '--card', 4.5],
  ['--primary-foreground', '--primary', 4.5],
  ['--sidebar-foreground', '--sidebar', 4.5],
  ['--warning-foreground', '--warning-soft', 4.5],

  ['--destructive-text', '--destructive-soft', 4.5],
  // Крупный текст и индикаторы: порог 3:1.
  ['--text-faint', '--card', 3],
  // Галочка выполненного шага и её подложка — индикатор, а не текст: порог 3:1.
  ['--success-foreground', '--success-soft', 3],
  ['--accent-strong', '--card', 3],
];
for (const mode of ['light', 'dark'])
  for (const [fg, bg, threshold] of PAIRS) {
    const a = palette.get(`${mode}${fg}`);
    const b = palette.get(`${mode}${bg}`);
    // Тёмная палитра пока определяет только набор shadcn; роли скина
    // появляются в ней на шаге 10, до тех пор пара пропускается.
    if (!a || !b) continue;
    const ratio = contrast(a, b);
    if (ratio + 1e-9 < threshold)
      fail(
        TOKENS,
        0,
        `контраст ${fg} на ${bg} (${mode}) = ${ratio.toFixed(2)}:1, нужно ${threshold}:1`,
      );
  }

// 9. Собранный CSS не растёт (план 08, тест 10). Предел: замер после стола
// Focus (TI-078, desk.css) 121 441 Б плюс 2 % на округление; новый экран или
// скин поднимает его осознанно, вместе с записью в план 08.
const BUNDLE_LIMIT = 123_900;
const assets = 'dist/web/assets';
if (!existsSync(assets)) {
  console.error(
    'check-skin: dist/web/assets не найден — бюджет CSS не проверен; сначала npm run build',
  );
  process.exit(1);
}
{
  for (const name of readdirSync(assets).filter((n) => n.endsWith('.css'))) {
    const size = statSync(join(assets, name)).size;
    if (size > BUNDLE_LIMIT)
      fail(
        join(assets, name),
        0,
        `собранный CSS ${size} Б больше предела ${BUNDLE_LIMIT} Б`,
      );
  }
}

if (problems.length) {
  console.error(`check-skin: ${problems.length} нарушений`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`check-skin: скин чист (${skinFiles.length} файлов)`);
