import { downloadText } from "@/lib/download-text";
import { loadBgImage, saveBgImage } from "@/lib/theme-storage";

declare const __APP_VERSION__: string;

const FORMAT = "harbor-backup";
const VERSION = 1;

export type Backup = {
  format: string;
  version: number;
  app: string;
  exportedAt: string;
  /** false: saved without API keys and sign-ins (a restore then keeps this device's). */
  secrets?: boolean;
  data: Record<string, string>;
  bgImage?: string | null;
};

const SETTINGS_KEY = "harbor.settings";

/** Sign-ins and own API apps kept under their own keys: left out of a backup without secrets. */
const SECRET_KEYS = new Set([
  "harbor.trakt.session.v1",
  "harbor.trakt.keys.v1",
  "harbor.simkl.session.v1",
  "harbor.simkl.keys.v1",
  "harbor.tvdb.token.v1",
]);

/** The settings that are keys or tokens, with the value an unset one has. */
const SECRET_SETTINGS: Record<string, string | number | null> = {
  tmdbKey: "",
  omdbKey: "",
  rpdbKey: "",
  fanartKey: "",
  tvdbKey: "",
  mdblistKey: "",
  aiSearchKey: "",
  opensubtitlesApiKey: "",
  jimakuToken: "",
  rdKey: "",
  tbKey: "",
  adKey: "",
  pmKey: "",
  dlKey: "",
  traktClientSecret: "",
  traktAccessToken: null,
  traktRefreshToken: null,
  traktExpiresAt: 0,
  togetherCfToken: "",
};
/** Webhook links carry their token in the address. */
const SECRET_WEBHOOK_FIELDS = ["discordUrl", "telegramUrl"] as const;

type Json = Record<string, unknown>;

function parseObject(raw: string | null | undefined): Json | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

/** The settings as saved, with every key and token emptied. */
function settingsWithoutSecrets(raw: string): string {
  const obj = parseObject(raw);
  if (!obj) return raw;
  for (const [k, empty] of Object.entries(SECRET_SETTINGS)) {
    if (k in obj) obj[k] = empty;
  }
  const hooks = obj.webhooks;
  if (hooks && typeof hooks === "object") {
    for (const f of SECRET_WEBHOOK_FIELDS) {
      if (f in (hooks as Json)) (hooks as Json)[f] = "";
    }
  }
  return JSON.stringify(obj);
}

/** [restored] settings with this device's keys and tokens ([current]) put back in. */
function settingsKeepingSecrets(restored: string, current: string | null): string {
  const next = parseObject(restored);
  const cur = parseObject(current);
  if (!next || !cur) return restored;
  for (const k of Object.keys(SECRET_SETTINGS)) {
    if (k in cur) next[k] = cur[k];
  }
  const curHooks = cur.webhooks;
  if (curHooks && typeof curHooks === "object") {
    const hooks = next.webhooks && typeof next.webhooks === "object" ? (next.webhooks as Json) : {};
    for (const f of SECRET_WEBHOOK_FIELDS) {
      if (f in (curHooks as Json)) hooks[f] = (curHooks as Json)[f];
    }
    next.webhooks = hooks;
  }
  return JSON.stringify(next);
}

function isPortable(key: string): boolean {
  if (!key.startsWith("harbor.")) return false;
  if (key === "harbor.auth" || key.startsWith("harbor.auth.")) return false;
  if (key === "harbor.together.clientId") return false;
  return true;
}

/**
 * [includeSecrets] false (the default): API and debrid keys, webhook links and the Trakt / Simkl
 * sign-ins stay out of the file, which is plain text. Addon links and playlists are saved as they
 * are either way: they are the setup itself.
 */
export async function buildBackup(includeSecrets = false): Promise<Backup> {
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !isPortable(key)) continue;
    if (!includeSecrets && SECRET_KEYS.has(key)) continue;
    const value = localStorage.getItem(key);
    if (value == null) continue;
    data[key] = !includeSecrets && key === SETTINGS_KEY ? settingsWithoutSecrets(value) : value;
  }
  const bgImage = await loadBgImage();
  return {
    format: FORMAT,
    version: VERSION,
    app: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev",
    exportedAt: new Date().toISOString(),
    secrets: includeSecrets,
    data,
    ...(bgImage ? { bgImage } : {}),
  };
}

export async function downloadBackup(includeSecrets = false): Promise<boolean> {
  const backup = await buildBackup(includeSecrets);
  const text = JSON.stringify(backup, null, 2);
  const stamp = new Date().toISOString().slice(0, 10);
  return downloadText(`harbor-backup-${stamp}.harbx`, text, ["harbx"], "Harbor backup");
}

export type ParsedBackup = { ok: true; backup: Backup } | { ok: false; error: string };

export function parseBackup(text: string): ParsedBackup {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file is not valid JSON." };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, error: "Unrecognized file." };
  }
  const b = json as Partial<Backup>;
  if (b.format !== FORMAT) {
    return { ok: false, error: "This is not a Harbor backup file." };
  }
  if (!b.data || typeof b.data !== "object") {
    return { ok: false, error: "This backup has no data in it." };
  }
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.data)) {
    if (typeof v === "string" && isPortable(k)) data[k] = v;
  }
  if (Object.keys(data).length === 0) {
    return { ok: false, error: "This backup contained nothing restorable." };
  }
  return {
    ok: true,
    backup: {
      format: FORMAT,
      version: typeof b.version === "number" ? b.version : VERSION,
      app: typeof b.app === "string" ? b.app : "unknown",
      exportedAt: typeof b.exportedAt === "string" ? b.exportedAt : "",
      ...(b.secrets === false ? { secrets: false } : {}),
      data,
      ...(typeof b.bgImage === "string" || b.bgImage === null ? { bgImage: b.bgImage } : {}),
    },
  };
}

export function backupKeyCount(backup: Backup): number {
  return Object.keys(backup.data).length;
}

export async function applyBackup(backup: Backup): Promise<void> {
  // A backup saved without keys and sign-ins leaves this device's in place (like the Stremio
  // sign-in): restoring it must not sign you out of Trakt or empty your API keys.
  const keepSecrets = backup.secrets === false;
  const currentSettings = keepSecrets ? localStorage.getItem(SETTINGS_KEY) : null;
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !isPortable(key)) continue;
    if (keepSecrets && SECRET_KEYS.has(key)) continue;
    stale.push(key);
  }
  for (const key of stale) localStorage.removeItem(key);
  for (const [k, v] of Object.entries(backup.data)) {
    if (!isPortable(k)) continue;
    if (keepSecrets && SECRET_KEYS.has(k)) continue;
    try {
      localStorage.setItem(k, keepSecrets && k === SETTINGS_KEY ? settingsKeepingSecrets(v, currentSettings) : v);
    } catch {
      /* keep restoring the rest even if one entry is rejected */
    }
  }
  if (backup.bgImage !== undefined) {
    try {
      await saveBgImage(backup.bgImage);
    } catch {
      /* background restore is best-effort */
    }
  }
}
