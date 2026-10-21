import { describeMessage, escapeHtml, formatMessage, getLocale, localeRegistry, onLocaleChange, setLocale, type MessageDescriptor } from './index';

const STORAGE_KEY = 'chrona:locale';
const attributes = ['title', 'aria-label', 'placeholder', 'alt'];
/** User content must not become a message just because its wording matches UI. */
export function setRawText(target: Node, value: unknown): void {
  target.textContent = value == null ? '' : String(value);
  if (target instanceof Element) { target.removeAttribute('data-i18n'); target.removeAttribute('data-i18n-params'); }
}
export function setText(target: Node, value: unknown): void {
  const text = value == null ? '' : String(value), descriptor = describeMessage(text);
  target.textContent = descriptor ? formatMessage(descriptor.key, descriptor.params) : text;
  if (target instanceof HTMLElement || target instanceof SVGElement) {
    if (descriptor) { target.setAttribute('data-i18n', descriptor.key); target.setAttribute('data-i18n-params', JSON.stringify(descriptor.params ?? {})); }
    else { target.removeAttribute('data-i18n'); target.removeAttribute('data-i18n-params'); }
  }
}
export function setTranslatedAttribute(target: Element, attribute: string, value: string): void {
  const descriptor = describeMessage(value);
  target.setAttribute(attribute, descriptor ? formatMessage(descriptor.key, descriptor.params) : value);
  if (descriptor) { target.setAttribute('data-i18n-' + attribute, descriptor.key); target.setAttribute('data-i18n-' + attribute + '-params', JSON.stringify(descriptor.params ?? {})); }
  else { target.removeAttribute('data-i18n-' + attribute); target.removeAttribute('data-i18n-' + attribute + '-params'); }
}
function params(element: Element, attribute: string): Record<string, unknown> {
  try { return JSON.parse(element.getAttribute(attribute) ?? '{}'); } catch { return {}; }
}
export function translateDom(root: ParentNode = document): void {
  root.querySelectorAll('[data-i18n]').forEach(element => {
    element.textContent = formatMessage(element.getAttribute('data-i18n')!, params(element, 'data-i18n-params'));
  });
  for (const attribute of attributes) root.querySelectorAll('[data-i18n-' + attribute + ']').forEach(element => {
    element.setAttribute(attribute, formatMessage(element.getAttribute('data-i18n-' + attribute)!, params(element, 'data-i18n-' + attribute + '-params')));
  });
}
export function initializeLanguage(): void {
  const query = new URLSearchParams(location.search).get('lang');
  let saved: string | null = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* Storage is optional. */ }
  setLocale(query ?? saved ?? 'en');
  document.documentElement.lang = getLocale();
  document.title = formatMessage('common.page-title');
}
export function mountLanguageSelector(): void {
  const select = document.getElementById('language-select') as HTMLSelectElement;
  select.innerHTML = localeRegistry.filter(locale => locale.enabled).map(locale => `<option value="${locale.code}">${escapeHtml(locale.label)}</option>`).join('');
  select.value = getLocale();
  select.addEventListener('change', () => {
    const locale = setLocale(select.value);
    try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* Storage is optional. */ }
    // An explicit URL override must agree with a subsequent user selection.
    const url = new URL(location.href); if (url.searchParams.has('lang')) { url.searchParams.set('lang', locale); history.replaceState(null, '', url); }
  });
  onLocaleChange(locale => {
    document.documentElement.lang = locale; select.value = locale;
    document.title = formatMessage('common.page-title');
    translateDom();
  });
  translateDom();
}
