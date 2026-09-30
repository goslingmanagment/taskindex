export function planCheck(
  scripts: Record<string, string>,
):
  | { ok: true; before: string[]; parts: string[]; lanes: string[][] }
  | { ok: false; reason: string };
