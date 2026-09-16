import en from './locales/en.json';
import errors from './locales/errors.en.json';
export type Language = 'system' | 'zh' | 'en';
export function preference(): Language {
  try { const value = localStorage.getItem('smbx-language'); if (value === 'zh' || value === 'en') return value; } catch {}
  return 'system';
}
export function resolveLanguage(value: Language, systemLanguage: string): 'zh' | 'en' {
  return value === 'system' ? (systemLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en') : value;
}
export const language = resolveLanguage(preference(), typeof navigator === 'undefined' ? 'zh' : navigator.language);
export function t(key: string, ...values: unknown[]): string {
  return translate(key, language, ...values);
}
export function translate(key: string, locale: 'zh' | 'en', ...values: unknown[]): string {
  const template = locale === 'en' ? (en as Record<string,string>)[key] ?? key : key;
  return template.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)] ?? ''));
}
export function saveLanguage(value: Language) { localStorage.setItem('smbx-language', value); }
export function localizeError(message: string, locale = language): string {
  if (locale !== 'en') return message;
  const translated = (errors as Record<string, string>)[message];
  if (translated) return translated;
  for (const [prefix, replacement] of [
    ['文件已不存在：', 'File no longer exists: '],
    ['不支持复制符号链接：', 'Cannot copy symbolic link: '],
    ['无法写入 macOS 文件剪贴板：', 'Cannot write to the macOS file clipboard: '],
  ]) { if (message.startsWith(prefix)) return replacement + message.slice(prefix.length); }
  // Preserve unknown diagnostics verbatim, especially paths and server-provided details.
  return message;
}
