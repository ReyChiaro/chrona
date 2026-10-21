import registry from '../../../locales/registry.json' with { type: 'json' };
import english from '../../../locales/en.json' with { type: 'json' };
import simplifiedChinese from '../../../locales/zh-Hans.json' with { type: 'json' };

export type MessageKey = keyof typeof english;
export type Locale = 'en' | 'zh-Hans';
export type MessageParams = Record<string, unknown>;
export interface MessageDescriptor { key: string; params?: MessageParams }
export const localeRegistry = registry.locales;
const catalogs: Record<Locale, Record<string, string>> = { en: english, 'zh-Hans': simplifiedChinese };
let activeLocale: Locale = 'en';
const listeners = new Set<(locale: Locale) => void>();
// Only strings produced by this module are registered. No pattern matching or
// translation of arbitrary user content takes place at transport boundaries.
const emitted = new Map<string, MessageDescriptor>();
const MAX_EMITTED = 8192;
export function normalizeLocale(value?: string | null): Locale {
  const tag = value?.trim().replace(/_/g, '-').toLowerCase() ?? '';
  const aliases = localeRegistry.flatMap(locale => locale.aliases.map(alias => ({ alias: alias.toLowerCase(), locale }))).sort((a, b) => b.alias.length - a.alias.length);
  const match = aliases.find(({ alias }) => tag === alias || tag.startsWith(alias + '-'));
  return match?.locale.enabled ? match.locale.code as Locale : 'en';
}
export function negotiateLocale(header?: string | null): Locale {
  const candidates = (header ?? '').split(',').map((item, index) => {
    const [tag, ...options] = item.trim().split(';');
    const quality = options.find(v => v.trim().startsWith('q='));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return { tag, q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0, index };
  }).filter(item => item.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of candidates) {
    if (/^en(?:-|$)/i.test(tag) || /^zh(?:-(?:hans|cn|sg)(?:-|$)|$)/i.test(tag)) return normalizeLocale(tag);
  }
  return 'en';
}
export const getLocale = (): Locale => activeLocale;
export function setLocale(value: string): Locale {
  const next = normalizeLocale(value);
  if (next !== activeLocale) { activeLocale = next; for (const listener of listeners) listener(next); }
  return next;
}
export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}
function remember(text: string, descriptor: MessageDescriptor): string {
  if (emitted.size >= MAX_EMITTED && !emitted.has(text)) emitted.delete(emitted.keys().next().value!);
  emitted.set(text, descriptor); return text;
}
export function formatMessage(key: string, params: MessageParams = {}, locale: Locale = activeLocale): string {
  const template = Object.hasOwn(catalogs[locale], key) ? catalogs[locale][key] : Object.hasOwn(catalogs.en, key) ? catalogs.en[key] : key;
  params = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  return template.replace(/\{([a-zA-Z]\w*)\}/g, (token, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) return value === null ? '' : token;
    if (isDescriptor(value)) return formatMessage(value.key, value.params, locale);
    return String(value);
  });
}
export function isDescriptor(value: unknown): value is MessageDescriptor {
  return !!value && typeof value === 'object' && typeof (value as MessageDescriptor).key === 'string' && Object.hasOwn(english, (value as MessageDescriptor).key);
}
export function t(key: MessageKey, params: MessageParams = {}, locale: Locale = activeLocale): string {
  return remember(formatMessage(key, params, locale), { key, ...(Object.keys(params).length ? { params } : {}) });
}
/** Canonical English for domain state, diagnostics and persistence. */
export function msg(key: MessageKey, params: MessageParams = {}): string { return t(key, params, 'en'); }
export function describeMessage(text: unknown): MessageDescriptor | undefined {
  return typeof text === 'string' ? emitted.get(text) : undefined;
}
export class LocalizedError extends Error {
  readonly code: string;
  readonly messageDescriptor: MessageDescriptor;
  constructor(key: MessageKey, params: MessageParams = {}) {
    super(t(key, params)); this.name = 'LocalizedError'; this.code = key; this.messageDescriptor = { key, params };
  }
}
export function errorPayload(error: unknown): { message: string; code?: string; params?: MessageParams } {
  const message = error instanceof Error ? error.message : String(error);
  const descriptor = error instanceof LocalizedError ? error.messageDescriptor : describeMessage(message);
  return { message, ...(descriptor ? { code: descriptor.key, params: descriptor.params } : {}) };
}
const machineFields = new Set(['error', 'detail', 'message', 'phase', 'summary', 'providerError', 'samplingNote', 'failures', 'warnings', 'unsupported']);
function matchingDescriptor(value: unknown, text: unknown): MessageDescriptor | undefined {
  return isDescriptor(value) && typeof text === 'string' && (formatMessage(value.key, value.params, 'en') === text || formatMessage(value.key, value.params, 'zh-Hans') === text) ? value : undefined;
}
/** Add descriptors to machine messages while retaining legacy string fields. */
export function annotatePayload(value: unknown, locale: Locale = 'en'): any {
  if (Array.isArray(value)) return value.map(item => annotatePayload(item, locale));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const object = value as Record<string, any>, result: Record<string, any> = Object.fromEntries(Object.keys(value).map(key => [key, undefined]));
  const metadata: Record<string, MessageDescriptor | (MessageDescriptor | null)[]> = { ...object._i18n };
  for (const [field, child] of Object.entries(object)) {
    if (field === '_i18n') continue;
    result[field] = annotatePayload(child, locale);
    if (machineFields.has(field)) {
      if (typeof child === 'string') {
        const previous = metadata[field];
        const descriptor = describeMessage(child) ?? matchingDescriptor(previous, child);
        if (!descriptor) delete metadata[field];
        if (descriptor && !Array.isArray(descriptor)) { metadata[field] = descriptor; result[field] = formatMessage(descriptor.key, descriptor.params, locale); }
      } else if (Array.isArray(child)) {
        const previous = metadata[field];
        const descriptors = child.map((text, i) => describeMessage(text) ?? matchingDescriptor(Array.isArray(previous) ? previous[i] : undefined, text) ?? null);
        if (descriptors.some(Boolean)) {
          metadata[field] = descriptors;
          result[field] = child.map((text, i) => descriptors[i] ? formatMessage(descriptors[i]!.key, descriptors[i]!.params, locale) : text);
        } else delete metadata[field];
      } else delete metadata[field];
    }
    const labelKey = object[field + 'Key'];
    if (typeof labelKey === 'string' && Object.hasOwn(english, labelKey)) { metadata[field] = { key: labelKey }; result[field] = formatMessage(labelKey, {}, locale); }
  }
  if (Object.keys(metadata).length) result._i18n = metadata;
  return result;
}
/** Read descriptors, including those attached to persisted jobs by Python. */
export function localizePayload<T>(value: T, locale: Locale = activeLocale): T {
  if (Array.isArray(value)) return value.map(item => localizePayload(item, locale)) as T;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const object = value as Record<string, any>, result: Record<string, any> = Object.fromEntries(Object.entries(object).map(([field, child]) => [field, field === '_i18n' ? child : localizePayload(child, locale)]));
  for (const [field, descriptor] of Object.entries(object._i18n ?? {}) as [string, any][]) {
    if (!Object.hasOwn(result, field)) continue;
    if (isDescriptor(descriptor) && typeof result[field] === 'string') result[field] = remember(formatMessage(descriptor.key, descriptor.params, locale), descriptor);
    else if (Array.isArray(descriptor) && Array.isArray(result[field])) result[field] = result[field].map((text: unknown, i: number) => isDescriptor(descriptor[i]) ? remember(formatMessage(descriptor[i].key, descriptor[i].params, locale), descriptor[i]) : text);
  }
  return result as T;
}
export const escapeHtml = (value: unknown): string => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export const dateLocale = (locale: Locale = activeLocale): string => localeRegistry.find(item => item.code === locale)?.dateLocale ?? 'en-US';
export function formatDate(value: string | number | Date, options?: Intl.DateTimeFormatOptions): string { return new Intl.DateTimeFormat(dateLocale(), options).format(new Date(value)); }
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string { return new Intl.NumberFormat(dateLocale(), options).format(value); }

/** Translate only recognized built-in demo names, keyed by package identity. */
export function displayAssetLabel(label: string, packageId?: string): string {
  const demo = Object.entries({ 'cherry-garden': 'cherry', 'riverside-bench': 'bench', 'lantern-evening': 'lantern', 'lavender-hills': 'meadow' }).find(([id]) => packageId?.startsWith(id + '@'))?.[1];
  const key = demo ? `demo.${demo}.label` : '';
  if (key && Object.hasOwn(english, key) && [catalogs.en[key], catalogs['zh-Hans'][key]].includes(label)) return t(key as MessageKey);
  return label;
}
export function formatCount(count: number, noun: 'chunk' | 'ring'): string {
  const descriptor = countMessage(count, noun);
  return formatMessage(descriptor.key, descriptor.params);
}
export function countMessage(count: number, noun: 'chunk' | 'ring'): MessageDescriptor {
  return { key: `common.${noun}.${new Intl.PluralRules(dateLocale()).select(count)}`, params: { count } };
}
