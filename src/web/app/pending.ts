import type { OperationEnvelope } from '@shared/model';
import { commandLabel, commandLabels } from './labels';
// Human text carried by a command payload, in display order.
const textFields = [
  'title',
  'name',
  'text',
  'description',
  'note',
  'waitingFor',
];
function textsOf(payload: unknown): string[] {
  const texts: string[] = [];
  const collect = (source: unknown) => {
    if (!source || typeof source !== 'object') return;
    for (const field of textFields) {
      const value = (source as Record<string, unknown>)[field];
      if (typeof value === 'string' && value.trim()) texts.push(value);
    }
  };
  collect(payload);
  if (payload && typeof payload === 'object' && 'fields' in payload)
    collect((payload as { fields: unknown }).fields);
  return texts;
}
/** TI-038: what a stranded envelope contains, so the owner can carry the text over by hand. */
export function describeEnvelope(envelope: OperationEnvelope): {
  title: string;
  texts: string[];
} {
  if ('commands' in envelope)
    return {
      title: `${commandLabels.batch}: ${envelope.commands.map((c) => commandLabel(c.command)).join(', ')}`,
      texts: envelope.commands.flatMap((c) => textsOf(c.payload)),
    };
  return {
    title: commandLabel(envelope.command),
    texts: textsOf(envelope.payload),
  };
}
