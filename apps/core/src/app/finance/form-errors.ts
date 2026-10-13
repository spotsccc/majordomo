export const FORM_ERRORS = {
  name: "Введите имя.",
  "name-taken": "Такое имя уже есть.",
  amount:
    "Начальный остаток — число больше нуля, не больше знаков после запятой, чем у валюты.",
  "wallet-used":
    "У кошелька есть транзакции, даже удалённые: его можно только убрать в архив.",
  currency:
    "Проверьте код, название и число знаков. Код фиатной валюты — три буквы ISO 4217.",
  "currency-taken": "Такая валюта уже есть.",
  funds: "Недостаточно средств: остаток ушёл бы в минус.",
  state: "Транзакция уже в этом состоянии.",
  internal: "Не получилось. Попробуйте ещё раз.",
} as const;

export type FormErrorCode = keyof typeof FORM_ERRORS;

export function formError(
  code: string | string[] | undefined,
): string | undefined {
  return typeof code === "string" && code in FORM_ERRORS
    ? FORM_ERRORS[code as FormErrorCode]
    : undefined;
}
