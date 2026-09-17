// A label id is typed by agents in `--labels`, so it is a readable Latin slug
// derived from the name: Cyrillic is transliterated, everything else that is
// not a letter or digit becomes a hyphen.
const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** @internal for tests */
export function slugify(text: string): string {
  const latin = text
    .toLocaleLowerCase('ru')
    .replace(/[а-яё]/g, (char) => CYRILLIC[char] ?? char);
  return latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}
// The first free slug for a name: the slug itself, then slug-2, slug-3, …
export function uniqueSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name) || 'label';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 40 - String(n).length - 1)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
