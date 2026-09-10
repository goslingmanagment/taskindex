import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Страж манифеста (план 09, шаг 1 и раздел 5, п. 1): зависимость, которую
// никто не импортирует, не должна вернуться незамеченной.
interface Manifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  overrides?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;

describe('манифест зависимостей', () => {
  it('не содержит date-fns: импортов в src, tests и scripts нет', () => {
    expect(manifest.dependencies).not.toHaveProperty('date-fns');
    expect(manifest.devDependencies).not.toHaveProperty('date-fns');
  });

  it('не содержит shadcn: базовый CSS вынесен в src/web/vendor', () => {
    // Шаг 2 плана 09 сделан: src/web/vendor/shadcn-base.css лежит в репозитории,
    // styles.css импортирует его. Генератор примитивов запускается разово через
    // `npx shadcn@latest add …`, в зависимости проекта он не возвращается.
    expect(manifest.dependencies).not.toHaveProperty('shadcn');
    expect(manifest.devDependencies).not.toHaveProperty('shadcn');
  });

  it('не содержит overrides: единственный потребитель undici ушёл с shadcn', () => {
    // `overrides.undici` держался ради ветки shadcn → @dotenvx/dotenvx → undici;
    // после снятия shadcn `npm ls undici` пуст (остался только undici-types
    // из @types/node). Новый override — повод объяснить его в этом тесте.
    expect(manifest.overrides).toBeUndefined();
  });
});
