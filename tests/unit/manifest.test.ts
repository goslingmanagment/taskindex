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

  it('shadcn и overrides.undici остаются до выноса CSS в src/web/vendor', () => {
    // Шаг 2 плана 09 (владелец C): скопировать dist/tailwind.css в
    // src/web/vendor/shadcn-base.css, после чего снять пакет и overrides и
    // заменить эти две проверки на отрицательные.
    expect(manifest.devDependencies).toHaveProperty('shadcn');
    expect(manifest.overrides).toEqual({ undici: '7.29.1' });
  });
});
