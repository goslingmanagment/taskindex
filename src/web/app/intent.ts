// TI-023 (план 07, доп. шаг 25; `astra-23`): один жизненный цикл намерения для
// всех форм. Формы отличаются полями, но не правилом «когда операция получает
// новый идентификатор»: раньше `QuickCreate` брал новый id при любом
// неповторяемом отказе, `InlineCreate` обнулял намерение целиком, а
// `TaskDiscussion` сохранял его — три разных ответа на один вопрос.
//
//   editing → persisted → sending → success | rejected | unknown
//
// Правила перехода:
//   • `success` очищает намерение: следующая отправка это новая операция;
//   • `rejected` (окончательный отказ) держит id до правки текста — повтор с тем
//     же телом сервер отклонит как `operation_mismatch`, а правка делает тело
//     другим, значит и операция другая;
//   • `unknown` (ответ не получен) держит id и конверт: судьбу решает повтор
//     через `store.retry`, а не новая операция.
/** @internal for tests */
export type IntentPhase =
  | 'editing'
  | 'persisted'
  | 'sending'
  | 'success'
  | 'rejected'
  | 'unknown';
export type Intent = {
  phase: IntentPhase;
  operationId: string;
  /** Подпись отправленного тела: по её смене видно, что владелец правил текст. */
  signature: string;
};
export type IntentEvent =
  | { type: 'edit'; signature: string }
  | { type: 'persist' }
  | { type: 'send'; signature: string }
  | { type: 'success' }
  | { type: 'reject'; retryable: boolean };
export const newIntent = (operationId: string): Intent => ({
  phase: 'editing',
  operationId,
  signature: '',
});
export function nextIntent(
  intent: Intent,
  event: IntentEvent,
  newId: () => string,
): Intent {
  switch (event.type) {
    case 'edit':
      // Незавершённая отправка правкой не отменяется: конверт всё ещё в pending.
      if (intent.phase === 'unknown' || intent.phase === 'sending')
        return intent;
      if (intent.phase === 'rejected')
        return event.signature === intent.signature
          ? intent
          : { phase: 'editing', operationId: newId(), signature: '' };
      return { ...intent, phase: 'editing', signature: '' };
    case 'persist':
      return intent.phase === 'editing'
        ? { ...intent, phase: 'persisted' }
        : intent;
    case 'send':
      return { ...intent, phase: 'sending', signature: event.signature };
    case 'success':
      return { phase: 'success', operationId: newId(), signature: '' };
    case 'reject':
      return {
        ...intent,
        phase: event.retryable ? 'unknown' : 'rejected',
      };
  }
}
