import { describe, expect, it } from 'vitest';
import { localizeError, resolveLanguage, translate } from './i18n';
import en from './locales/en.json';

describe('language selection', () => {
  it('translates backend errors without changing filenames or unknown server diagnostics', () => {
    expect(localizeError('连接不存在', 'en')).toBe('Connection not found');
    expect(localizeError('文件已不存在：/资料/文件.txt', 'en')).toBe('File no longer exists: /资料/文件.txt');
    expect(localizeError('NT_STATUS_ACCESS_DENIED: /资料', 'en')).toBe('NT_STATUS_ACCESS_DENIED: /资料');
  });
  it('follows Chinese locales and falls back to English for other system languages', () => {
    expect(resolveLanguage('system', 'zh-CN')).toBe('zh');
    expect(resolveLanguage('system', 'zh-TW')).toBe('zh');
    expect(resolveLanguage('system', 'fr-FR')).toBe('en');
    expect(resolveLanguage('en', 'zh-CN')).toBe('en');
    expect(resolveLanguage('zh', 'en-US')).toBe('zh');
  });
  it('keeps user filenames and connection names intact while translating the surrounding UI', () => {
    expect(translate('已连接 {0}', 'en', '家庭 NAS {1}')).toBe('Connected to 家庭 NAS {1}');
    expect(translate('已连接 {0}', 'zh', 'Home NAS')).toBe('已连接 Home NAS');
    expect(translate('项目说明.pdf', 'en')).toBe('项目说明.pdf');
  });
  it('preserves every placeholder in English messages, including destructive confirmations', () => {
    for (const [key, value] of Object.entries(en)) {
      expect((value.match(/\{\d+\}/g) || []).sort(), key).toEqual((key.match(/\{\d+\}/g) || []).sort());
    }
    expect(translate('永久删除 {0} 个项目？', 'en', 3)).toBe('Permanently delete 3 items?');
  });
});
