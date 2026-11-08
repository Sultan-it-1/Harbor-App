export type UiLanguage = "en" | "ar";

export type LanguageOption = {
  code: UiLanguage;
  label: string;
  nativeLabel: string;
  rtl: boolean;
};

export const LANGUAGES: LanguageOption[] = [
  { code: "en", label: "English", nativeLabel: "English", rtl: false },
  { code: "ar", label: "Arabic", nativeLabel: "العربية", rtl: true },
];

export function isRtl(lang: UiLanguage): boolean {
  return lang === "ar";
}
