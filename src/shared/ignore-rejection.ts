// A rejection nobody awaits, with the reason written down (plan 10, §3.5).
// `promise.catch(() => {})` alone hides two different things: a failure that is
// already handled elsewhere, and a failure nobody thought about. The `reason`
// argument forces the first to be stated, and shows up in the browser console
// during development so the silence is visible while working on the code.
export function ignoreRejection(promise: Promise<unknown>, reason: string) {
  void promise.catch((error: unknown) => {
    if (import.meta.env?.DEV) console.debug('ignored rejection', reason, error);
  });
}
