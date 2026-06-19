import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zh from './locales/zh.json';

export type WebLanguage = 'zh' | 'en';

const LANGUAGE_STORAGE_KEY = 'lingxiao-locale';

export function normalizeLanguage(value: unknown): WebLanguage | null {
  // 与服务端 src/i18n.ts normalizeLanguage 共享同一变体集（统一 locale 契约）：
  // zh / cn / zh-CN 等 → 'zh'；en / us / en-US 等 → 'en'；未知 → null。
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase().trim();
  if (lower.startsWith('zh') || lower.startsWith('cn')) return 'zh';
  if (lower.startsWith('en') || lower.startsWith('us')) return 'en';
  return null;
}

export function persistLanguage(language: WebLanguage): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify({ language }));
  } catch (err) {
    console.warn('[i18n] Failed to persist language preference:', err);
  }
}

const savedLocale = (() => {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : null;
    const language = normalizeLanguage(parsed?.language);
    if (language) return language;
  } catch (err) {
    console.warn('[i18n] Failed to load saved language preference:', err);
  }
  return 'zh';
})();

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: savedLocale,
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
});

i18n.on('languageChanged', (language) => {
  const normalized = normalizeLanguage(language);
  if (normalized) persistLanguage(normalized);
});

export default i18n;
