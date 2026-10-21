import { AsyncLocalStorage } from "node:async_hooks";
import { negotiateLocale, type Locale } from "../../../packages/i18n/src/index";

const context = new AsyncLocalStorage<Locale>();
export const requestLocale = (): Locale => context.getStore() ?? "en";
export function withRequestLocale<T>(
  header: string | undefined,
  work: () => T,
): T {
  return context.run(negotiateLocale(header), work);
}
