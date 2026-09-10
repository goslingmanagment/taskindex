export function checkNode(
  version: string,
  engines: string,
): { ok: true } | { ok: false; message: string };
export function readPins(root?: URL): { engines: string; pinned: string };
