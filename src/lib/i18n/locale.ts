import { getUiLanguage } from "./store";

/**
 * The locale for Intl and toLocale*String: the app's language, not the phone's, so an Arabic
 * interface gets Arabic month and day names (with the Western digits the rest of the UI uses)
 * and an English one stays English on an Arabic phone. An English variant of the device
 * (en-GB, en-AU…) is kept for its date order.
 */
export function uiLocale(): string {
  const lang = getUiLanguage();
  if (lang === "ar") return "ar-u-nu-latn";
  const device = typeof navigator !== "undefined" ? navigator.language || "" : "";
  return device.toLowerCase().startsWith(`${lang}-`) || device.toLowerCase() === lang ? device : lang;
}
