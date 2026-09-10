import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '../../ui/select';
// Выпадающий выбор с подписью. `id` — слаг для `label htmlFor` (план 07, шаг 16);
// `aria-label` остаётся, поэтому тесты по ролям не меняются. Модуль отдельный от
// редактора: карточка грузится лениво, а диалоги создания — нет.
export function Choice({
  id,
  value,
  onChange,
  items,
  label,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  items: { value: string; label: string }[];
  label: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(String(v));
      }}
      items={items}
    >
      <SelectTrigger id={id} className="field-select" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
