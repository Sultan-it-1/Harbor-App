import { androidSaveFile, isAndroidApp } from "@/lib/android";

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function mimeForExt(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (e === "json") return "application/json";
  if (e === "srt" || e === "vtt" || e === "ass" || e === "ssa") return "text/plain";
  if (e === "css") return "text/css";
  if (e === "m3u" || e === "m3u8") return "audio/x-mpegurl";
  if (e === "txt" || e === "log") return "text/plain";
  // Our own formats (.harbx backups ...): a text type would make Android add ".txt".
  return "application/octet-stream";
}

export type SaveResult = { saved: boolean; path: string | null };

export async function saveTextFileWithPath(
  filename: string,
  text: string,
  extensions: string[],
  label = "Harbor",
): Promise<SaveResult> {
  if (IS_TAURI) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await save({ defaultPath: filename, filters: [{ name: label, extensions }] });
      if (!path) return { saved: false, path: null };
      await invoke("save_text_file", { path, contents: text });
      return { saved: true, path };
    } catch (err) {
      console.warn("[harbor] native save failed, falling back", err);
    }
  }
  if (isAndroidApp()) {
    // The WebView ignores <a download>: the "Saved" message used to show for a file that was
    // never written. Ask Android where to put it instead.
    const ext = extensions[0] ?? filename.split(".").pop() ?? "txt";
    const saved = await androidSaveFile(filename, mimeForExt(ext), text);
    return { saved, path: null };
  }
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { saved: true, path: null };
}

export async function downloadText(
  filename: string,
  text: string,
  extensions: string[],
  label = "Harbor",
): Promise<boolean> {
  const { saved } = await saveTextFileWithPath(filename, text, extensions, label);
  return saved;
}
