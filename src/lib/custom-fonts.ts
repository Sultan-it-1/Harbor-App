import { useState } from "react";
import { t } from "./i18n/translate";
import { useSettings } from "./settings";

const EXT_FORMAT: Record<string, string> = {
  ttf: "truetype",
  otf: "opentype",
  woff: "woff",
  woff2: "woff2",
};

// Fonts are saved inside the settings, in localStorage: about 5 MB for everything the app keeps
// there, and a font takes a third more than its file as text. Past the quota the settings stop
// saving, so one font is capped well below it, and all of them together too.
export const MAX_FONT_BYTES = 1024 * 1024;
const MAX_FONTS_CHARS = 2 * 1024 * 1024;

/** Whether one more font (as a data URL) still fits next to the saved ones. */
export function customFontsHaveRoom(fonts: Array<{ dataUrl: string }>, dataUrl: string): boolean {
  return fonts.reduce((n, f) => n + f.dataUrl.length, dataUrl.length) <= MAX_FONTS_CHARS;
}

export function useCustomFonts() {
  const { settings, update } = useSettings();
  const fonts = settings.customFonts ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addFont = async (file: File): Promise<string | null> => {
    setError(null);
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    const format = EXT_FORMAT[ext];
    if (!format) {
      setError(t("Use a TTF, OTF, WOFF or WOFF2 file."));
      return null;
    }
    if (file.size > MAX_FONT_BYTES) {
      setError(t("That font is over {n} MB. Try a lighter file (WOFF2 is the smallest).", { n: 1 }));
      return null;
    }
    setBusy(true);
    try {
      const dataUrl = await readDataUrl(file);
      if (!customFontsHaveRoom(fonts, dataUrl)) {
        setError(t("No room for another font. Remove one first."));
        return null;
      }
      const id = crypto.randomUUID().slice(0, 8);
      await new FontFace(`harbor-font-${id}`, `url(${dataUrl})`, { display: "swap" }).load();
      update({ customFonts: [...fonts, { id, name: prettyName(file.name), dataUrl, format }] });
      return id;
    } catch {
      setError(t("That file is not a valid font."));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const removeFont = (id: string) => {
    update({ customFonts: fonts.filter((f) => f.id !== id) });
  };

  return { fonts, busy, error, addFont, removeFont, clearError: () => setError(null) };
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function prettyName(filename: string): string {
  const base = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base ? base.slice(0, 36) : "Custom font";
}
