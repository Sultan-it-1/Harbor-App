import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  androidDownloadsAvailable,
  nativeBgAllowed,
  nativeBgRequest,
  nativeFiles,
  nativeSetWifiOnly,
  nativeStorage,
  nativeWifiOnly,
} from "@/lib/download/android-downloads";
import { useT } from "@/lib/i18n";
import { stopSeasonDownload, useRunningSeasonJobs } from "@/lib/download/season-download";
import {
  BatteryCharging,
  Check,
  Download as DownloadIcon,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  RotateCw,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import { Poster } from "@/components/poster";
import { useView } from "@/lib/view";
import { DownloadDirBar } from "./downloads/download-dir-bar";
import { useNativeBrowsePage } from "@/views/native/native-screens";
import {
  cancelDownload,
  fetchDownloadSubtitles,
  pauseDownload,
  refreshDownloads,
  removeDownload,
  resumeDownload,
  revealDownload,
  useDownloads,
  type DownloadItem,
} from "@/lib/download/downloads-store";

function fmtBytes(n: number | null): string {
  if (n == null || n <= 0) return "";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

function fmtSpeed(bps: number): string {
  if (bps <= 0) return "";
  if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)} MB/s`;
  return `${(bps / 1024).toFixed(0)} KB/s`;
}

type TFn = ReturnType<typeof useT>;

function fmtEta(d: DownloadItem, t: TFn): string {
  if (d.bytesPerSec <= 0 || d.totalBytes == null) return "";
  const remain = d.totalBytes - d.receivedBytes;
  if (remain <= 0) return "";
  const secs = remain / d.bytesPerSec;
  if (secs >= 3600) return t("{n}h left", { n: Math.round(secs / 3600) });
  if (secs >= 60) return t("{n}m left", { n: Math.round(secs / 60) });
  return t("{n}s left", { n: Math.round(secs) });
}

/** Android: the app's downloader reports codes (Downloads.kt); shown in the app's language. */
function noteText(d: DownloadItem, t: TFn): string | null {
  switch (d.code) {
    case "queued":
      return t("Queued");
    case "waiting_network":
      return t("Waiting for internet");
    case "waiting_wifi":
      return t("Waiting for Wi-Fi");
    case "retry_in":
      return t("Retrying in {n}s", { n: d.sec ?? 0 });
    case "paused":
      return t("Paused");
    case "relinking":
      return t("Getting a fresh link…");
  }
  return d.note ? t(d.note) : null;
}

function errorText(d: DownloadItem, t: TFn): string {
  const http = d.http ?? 0;
  switch (d.code) {
    case "expired":
      return t("The link expired (HTTP {code}). Tap retry for a fresh one.", { code: http });
    case "refused":
      return t("The server refused the download (HTTP {code}). Tap retry for a fresh link.", { code: http });
    case "http_error":
      return t("The server refused the download (HTTP {code})", { code: http });
    case "no_space":
      return t("Not enough storage on the phone");
    case "not_media":
      return t("This link isn't a video file (a web page or a streaming playlist). Try another source.");
    case "keeps_failing":
      return t("Keeps failing. Tap retry.");
    case "save_failed":
      return t("Couldn't save the file");
  }
  return t("Failed: {error}", { error: d.error ? t(d.error) : t("Download failed") });
}

type DownloadGroup =
  | { kind: "movie"; item: DownloadItem }
  | { kind: "show"; metaId: string; title: string; poster: string | null; items: DownloadItem[] };

function statusRank(s: DownloadItem["status"]): number {
  return s === "downloading" ? 0 : s === "error" ? 1 : s === "done" ? 2 : 3;
}

function buildGroups(items: DownloadItem[]): DownloadGroup[] {
  const shows = new Map<string, DownloadItem[]>();
  const movies: DownloadItem[] = [];
  for (const d of items) {
    if (d.season != null) {
      const arr = shows.get(d.metaId);
      if (arr) arr.push(d);
      else shows.set(d.metaId, [d]);
    } else {
      movies.push(d);
    }
  }
  const groups: DownloadGroup[] = movies.map((item) => ({ kind: "movie", item }));
  for (const [metaId, arr] of shows) {
    groups.push({ kind: "show", metaId, title: arr[0].title, poster: arr[0].poster, items: arr });
  }
  const keyOf = (g: DownloadGroup) => {
    const its = g.kind === "movie" ? [g.item] : g.items;
    return {
      best: Math.min(...its.map((d) => statusRank(d.status))),
      recent: Math.max(...its.map((d) => d.startedAt)),
    };
  };
  return groups.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka.best - kb.best || kb.recent - ka.recent;
  });
}

// Android app: files live in the app's own storage (no folder to pick or reveal).
const ANDROID = androidDownloadsAvailable();

function StorageLine({ items }: { items: DownloadItem[] }) {
  const t = useT();
  const [info, setInfo] = useState<{ free?: number; used?: number }>({});
  const doneCount = items.filter((d) => d.status === "done").length;
  useEffect(() => {
    setInfo(nativeStorage());
  }, [items.length, doneCount]);
  if (info.free == null || info.free < 0) return null;
  return (
    <p className="mb-5 text-[12.5px] text-ink-subtle">
      {[t("Stored in the app"), (info.used ?? 0) > 0 ? t("{size} used", { size: fmtBytes(info.used ?? 0) }) : null, t("{size} free on this phone", { size: fmtBytes(info.free) })]
        .filter(Boolean)
        .join(" · ")}
    </p>
  );
}

/**
 * Android: downloads run in the background, but battery savers (especially on Xiaomi, Samsung,
 * Huawei…) can still stop them. Offers the system "let it run in the background" prompt.
 */
/**
 * Android: downloads use Wi-Fi only unless mobile data is allowed here (one tap on a season
 * download used to be able to use up a monthly data plan).
 */
function WifiOnlyCard({ waiting }: { waiting: boolean }) {
  const t = useT();
  const [wifiOnly, setWifiOnly] = useState<boolean | null>(() => nativeWifiOnly());
  if (wifiOnly == null) return null;
  const toggle = () => {
    nativeSetWifiOnly(!wifiOnly);
    setWifiOnly(!wifiOnly);
  };
  return (
    <div
      className={`mb-5 flex items-center gap-3 rounded-2xl border px-4 py-3 ${
        waiting && wifiOnly ? "border-accent/25 bg-accent/10" : "border-edge-soft bg-elevated/30"
      }`}
    >
      <Wifi size={18} className="shrink-0 text-accent" strokeWidth={2} />
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-muted">
        {wifiOnly
          ? waiting
            ? t("Waiting for Wi-Fi. Downloads don't use mobile data unless you allow it.")
            : t("Downloads use Wi-Fi only.")
          : t("Downloads also use mobile data.")}
      </p>
      {/* A plain button: its text says what tapping does ("Use mobile data" / "Wi-Fi only").
          As a switch with that changing text, TalkBack read the opposite state. */}
      <button
        type="button"
        onClick={toggle}
        className={`h-9 shrink-0 rounded-lg px-3 text-[12.5px] font-semibold ${
          wifiOnly ? "bg-accent text-canvas" : "bg-ink/10 text-ink"
        }`}
      >
        {wifiOnly ? t("Use mobile data") : t("Wi-Fi only")}
      </button>
    </div>
  );
}

function BackgroundRunCard({ busy }: { busy: boolean }) {
  const t = useT();
  const [allowed, setAllowed] = useState<boolean | null>(() => nativeBgAllowed());
  useEffect(() => {
    const recheck = () => setAllowed(nativeBgAllowed());
    window.addEventListener("harbor:resume", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("harbor:resume", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);
  if (allowed !== false || !busy) return null;
  return (
    <div className="mb-5 flex items-center gap-3 rounded-2xl border border-accent/25 bg-accent/10 px-4 py-3">
      <BatteryCharging size={20} className="shrink-0 text-accent" strokeWidth={2} />
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-muted">
        {t("Downloads keep going when you leave the app. If your phone still stops them, let Harbor run without battery limits.")}
      </p>
      <button
        type="button"
        onClick={() => nativeBgRequest()}
        className="h-9 shrink-0 rounded-lg bg-accent px-3 text-[12.5px] font-semibold text-canvas"
      >
        {t("Allow")}
      </button>
    </div>
  );
}

/** "Download season" queues still looking for sources for the next episodes. */
function SeasonJobs() {
  const t = useT();
  const jobs = useRunningSeasonJobs();
  if (jobs.length === 0) return null;
  return (
    <div className="mb-4 flex flex-col gap-2">
      {jobs.map((j) => (
        <div key={j.key} className="flex items-center gap-3 rounded-2xl border border-edge-soft bg-elevated/40 px-4 py-2.5">
          <Loader2 size={16} className="shrink-0 animate-spin text-ink-subtle" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-muted">
            {t("Finding sources · {title} · {n}/{total}", {
              title: `${j.title}${j.season != null ? ` S${j.season}` : ""}`,
              n: Math.min(j.progress.done + 1, j.progress.total),
              total: j.progress.total,
            })}
          </span>
          <RowBtn label={t("Stop")} onClick={() => stopSeasonDownload(j.key)}>
            <X size={16} strokeWidth={2.2} />
          </RowBtn>
        </div>
      ))}
    </div>
  );
}

/** Plays a saved download (Android: the file and the subtitles saved next to it). */
function playDownload(d: DownloadItem, openPlayer: ReturnType<typeof useView>["openPlayer"]): void {
  const local = ANDROID ? nativeFiles(d.id) : null;
  openPlayer({
    meta: {
      id: d.metaId,
      type: d.season != null ? "series" : "movie",
      name: d.title,
      poster: d.poster ?? undefined,
    },
    episode: d.season != null && d.episode != null ? { season: d.season, episode: d.episode } : undefined,
    url: local?.video ?? d.path,
    title: d.title,
    subtitle: d.subtitle ?? undefined,
    subtitles: local?.subtitles.map((x) => ({ url: x.url, lang: x.lang, label: x.label })),
    notWebReady: true,
  });
}

/** A download as the native screen draws it (the page's DownloadRow). */
function nativeDownloadItem(d: DownloadItem, compact: boolean, confirming: boolean, t: TFn) {
  const downloading = d.status === "downloading";
  const pct = Math.round(d.ratio * 100);
  const subsShown = ANDROID && (downloading || d.status === "done");
  const n = d.subsCount ?? 0;
  const buttons: Array<{ id: string; label: string }> = [];
  if (downloading) {
    if (ANDROID && d.code !== "relinking") {
      buttons.push(d.paused ? { id: "resume", label: t("Resume download") } : { id: "pause", label: t("Pause download") });
    }
    buttons.push({ id: "cancel", label: t("Cancel download") });
  } else {
    if (ANDROID && d.status === "error" && d.retryable !== false) buttons.push({ id: "retry", label: t("Retry download") });
    if (d.status === "done") buttons.push({ id: "play", label: t("Play") });
    buttons.push(confirming ? { id: "confirm", label: t("Delete") } : { id: "delete", label: t("Delete download and file") });
  }
  return {
    id: d.id,
    title: compact ? (d.subtitle ?? d.title) : d.title,
    side: !compact && d.subtitle ? d.subtitle : null,
    img: d.poster ? [d.poster] : [],
    compact,
    progress: downloading ? d.ratio : -1,
    paused: !!d.paused,
    stats: downloading
      ? [
          `${pct}%${d.totalBytes != null ? `  ${fmtBytes(d.receivedBytes)} / ${fmtBytes(d.totalBytes)}` : ""}`,
          fmtSpeed(d.bytesPerSec) || null,
          fmtEta(d, t) || null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null,
    note: downloading ? noteText(d, t) : null,
    status: d.status,
    statusText:
      d.status === "done"
        ? `${t("Saved")}${d.streamLabel ? ` · ${d.streamLabel}` : ""}${d.totalBytes ? ` · ${fmtBytes(d.totalBytes)}` : ""}`
        : d.status === "error"
          ? errorText(d, t)
          : d.status === "canceled"
            ? t("Canceled")
            : d.status === "interrupted"
              ? t("Interrupted: re-download to finish")
              : null,
    subs: !subsShown ? null : d.subsState === "searching" ? t("finding subtitles…") : n > 0 ? (n === 1 ? t("1 subtitle") : t("{count} subtitles", { count: n })) : null,
    subsAction: subsShown && d.subsState !== "searching" && n === 0 ? t("Get subtitles") : null,
    buttons,
  };
}

export function DownloadsView() {
  const t = useT();
  const items = useDownloads();
  const seasonJobs = useRunningSeasonJobs();
  const active = items.filter((d) => d.status === "downloading").length;
  // Subtitles saved from the player etc. show up without waiting for a download to run.
  useEffect(() => {
    refreshDownloads();
  }, []);
  const savedBytes = items.reduce(
    (sum, d) => (d.status === "done" ? sum + (d.totalBytes ?? d.receivedBytes) : sum),
    0,
  );
  const groups = useMemo(() => buildGroups(items), [items]);

  // Android: drawn natively (see @/views/native/native-screens) like the page: "Downloads" and
  // its summary, where files are kept and what's free, the Wi-Fi only and battery cards, the
  // season searches still finding sources (Stop), then the films and the shows' episodes with
  // their bar, speed, time left, subtitles and buttons (pause / resume, cancel, retry, play,
  // delete, then Delete to confirm).
  const { topKind, openPlayer } = useView();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmId) return;
    const timer = window.setTimeout(() => setConfirmId(null), 3500);
    return () => window.clearTimeout(timer);
  }, [confirmId]);
  const [wifiOnly, setWifiOnly] = useState<boolean | null>(() => (ANDROID ? nativeWifiOnly() : null));
  const [bgAllowed, setBgAllowed] = useState<boolean | null>(() => (ANDROID ? nativeBgAllowed() : null));
  useEffect(() => {
    if (!ANDROID) return;
    const recheck = () => setBgAllowed(nativeBgAllowed());
    window.addEventListener("harbor:resume", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("harbor:resume", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);
  const doneCount = items.filter((d) => d.status === "done").length;
  const storage = useMemo(() => (ANDROID ? nativeStorage() : {}), [items.length, doneCount]);
  const summary =
    items.length === 0
      ? t("Saved movies and episodes for offline watching")
      : [
          items.length === 1 ? t("1 item") : t("{count} items", { count: items.length }),
          active > 0 ? t("{count} downloading", { count: active }) : null,
          savedBytes > 0 ? t("{size} saved", { size: fmtBytes(savedBytes) }) : null,
        ]
          .filter(Boolean)
          .join("  ·  ");
  const nativeDownloads = useMemo(() => {
    const waitingWifi = items.some((d) => d.code === "waiting_wifi");
    const notices: Array<Record<string, unknown>> = [];
    if (wifiOnly != null) {
      notices.push({
        id: "wifi",
        icon: "wifi",
        text: wifiOnly
          ? waitingWifi
            ? t("Waiting for Wi-Fi. Downloads don't use mobile data unless you allow it.")
            : t("Downloads use Wi-Fi only.")
          : t("Downloads also use mobile data."),
        action: wifiOnly ? t("Use mobile data") : t("Wi-Fi only"),
        actionOn: wifiOnly,
        accent: waitingWifi && wifiOnly,
      });
    }
    if (bgAllowed === false && (active > 0 || seasonJobs.length > 0)) {
      notices.push({
        id: "battery",
        icon: "battery",
        text: t("Downloads keep going when you leave the app. If your phone still stops them, let Harbor run without battery limits."),
        action: t("Allow"),
        actionOn: true,
        accent: true,
      });
    }
    return {
      storage:
        storage.free != null && storage.free >= 0
          ? [
              t("Stored in the app"),
              (storage.used ?? 0) > 0 ? t("{size} used", { size: fmtBytes(storage.used ?? 0) }) : null,
              t("{size} free on this phone", { size: fmtBytes(storage.free) }),
            ]
              .filter(Boolean)
              .join(" · ")
          : null,
      notices,
      jobs: seasonJobs.map((j) => ({
        key: j.key,
        text: t("Finding sources · {title} · {n}/{total}", {
          title: `${j.title}${j.season != null ? ` S${j.season}` : ""}`,
          n: Math.min(j.progress.done + 1, j.progress.total),
          total: j.progress.total,
        }),
        stop: t("Stop"),
      })),
      groups: groups.map((g) => {
        if (g.kind === "movie") return { key: g.item.id, title: null, items: [nativeDownloadItem(g.item, false, confirmId === g.item.id, t)] };
        const eps = [...g.items].sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
        const bytes = eps.reduce((sum, d) => (d.status === "done" ? sum + (d.totalBytes ?? d.receivedBytes) : sum), 0);
        return {
          key: `show:${g.metaId}`,
          title: g.title,
          sub: `${eps.length === 1 ? t("1 episode") : t("{count} episodes", { count: eps.length })}${bytes > 0 ? `  ·  ${fmtBytes(bytes)}` : ""}`,
          img: g.poster ? [g.poster] : [],
          items: eps.map((d) => nativeDownloadItem(d, true, confirmId === d.id, t)),
        };
      }),
    };
  }, [t, items, groups, wifiOnly, bgAllowed, active, seasonJobs, storage, confirmId]);
  const native = useNativeBrowsePage("downloads", {
    active: topKind === "downloads",
    t,
    header: { title: t("Downloads"), size: 28, subtitle: summary },
    rows: [],
    downloads: nativeDownloads,
    message:
      items.length === 0
        ? {
            title: t("No downloads yet"),
            text: ANDROID
              ? t("Open any movie or show and tap the download button (or Download season on a show). It saves in the app with its subtitles for offline watching.")
              : t("Open any movie or show, hover an episode, and click the download icon. Pick the exact source you want and it saves here for offline watching."),
          }
        : null,
    onDownloads: (what, id) => {
      if (what === "notice") {
        if (id === "wifi" && wifiOnly != null) {
          nativeSetWifiOnly(!wifiOnly);
          setWifiOnly(!wifiOnly);
        } else if (id === "battery") nativeBgRequest();
        return;
      }
      if (what === "stopjob") return stopSeasonDownload(id);
      const d = items.find((x) => x.id === id);
      if (!d) return;
      switch (what) {
        case "pause":
          return pauseDownload(d.id);
        case "resume":
        case "retry":
          return resumeDownload(d.id);
        case "cancel":
          return cancelDownload(d.id);
        case "play":
          return playDownload(d, openPlayer);
        case "delete":
          return setConfirmId(d.id);
        case "confirm":
          setConfirmId(null);
          return removeDownload(d.id);
        case "subs":
          return fetchDownloadSubtitles(d.id);
      }
    },
  });
  if (native) return <main className="flex-1 overflow-hidden bg-canvas" />;

  return (
    <main className="flex-1 overflow-y-auto bg-canvas px-5 pb-24 pt-24 sm:px-8 lg:px-12 lg:pt-28">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-8">
          <h1 className="text-[28px] font-semibold tracking-tight text-ink">{t("Downloads")}</h1>
          <p className="mt-1.5 text-[13.5px] text-ink-subtle">
            {items.length === 0
              ? t("Saved movies and episodes for offline watching")
              : [
                  items.length === 1 ? t("1 item") : t("{count} items", { count: items.length }),
                  active > 0 ? t("{count} downloading", { count: active }) : null,
                  savedBytes > 0 ? t("{size} saved", { size: fmtBytes(savedBytes) }) : null,
                ]
                  .filter(Boolean)
                  .join("  ·  ")}
          </p>
        </header>

        {ANDROID ? <StorageLine items={items} /> : <DownloadDirBar />}
        {ANDROID && <WifiOnlyCard waiting={items.some((d) => d.code === "waiting_wifi")} />}
        {ANDROID && <BackgroundRunCard busy={active > 0 || seasonJobs.length > 0} />}
        <SeasonJobs />

        {items.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-2.5">
            {groups.map((g) =>
              g.kind === "movie" ? (
                <ul key={g.item.id} className="contents">
                  <DownloadRow d={g.item} />
                </ul>
              ) : (
                <ShowGroup key={g.metaId} group={g} />
              ),
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-[20px] border border-dashed border-edge-soft bg-elevated/30 px-8 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-elevated text-ink-subtle">
        <DownloadIcon size={26} strokeWidth={1.8} />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-[15px] font-semibold text-ink">{t("No downloads yet")}</p>
        <p className="max-w-[340px] text-[13.5px] leading-relaxed text-ink-muted">
          {ANDROID
            ? t("Open any movie or show and tap the download button (or Download season on a show). It saves in the app with its subtitles for offline watching.")
            : t("Open any movie or show, hover an episode, and click the download icon. Pick the exact source you want and it saves here for offline watching.")}
        </p>
      </div>
    </div>
  );
}

function ShowGroup({ group }: { group: Extract<DownloadGroup, { kind: "show" }> }) {
  const t = useT();
  const episodes = useMemo(
    () =>
      [...group.items].sort(
        (a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0),
      ),
    [group.items],
  );
  const totalBytes = episodes.reduce(
    (sum, d) => (d.status === "done" ? sum + (d.totalBytes ?? d.receivedBytes) : sum),
    0,
  );
  return (
    <div className="overflow-hidden rounded-2xl border border-edge-soft bg-elevated/25">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="h-[52px] w-[36px] shrink-0 overflow-hidden rounded-md">
          <Poster src={group.poster ?? undefined} seed={group.metaId} ratio="portrait" />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[14px] font-semibold text-ink">{group.title}</span>
          <span className="text-[11.5px] text-ink-subtle">
            {episodes.length === 1 ? t("1 episode") : t("{count} episodes", { count: episodes.length })}
            {totalBytes > 0 ? `  ·  ${fmtBytes(totalBytes)}` : ""}
          </span>
        </div>
      </div>
      <ul className="flex flex-col gap-1.5 border-t border-edge-soft/50 px-2 pb-2 pt-2">
        {episodes.map((d) => (
          <DownloadRow key={d.id} d={d} compact />
        ))}
      </ul>
    </div>
  );
}

function DownloadRow({ d, compact = false }: { d: DownloadItem; compact?: boolean }) {
  const t = useT();
  const { openPlayer } = useView();
  const pct = Math.round(d.ratio * 100);
  const downloading = d.status === "downloading";
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = window.setTimeout(() => setConfirmDelete(false), 3500);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);
  const playLocal = () => playDownload(d, openPlayer);
  return (
    <li className="group flex items-center gap-4 rounded-2xl border border-edge-soft bg-elevated/40 p-3 transition-colors hover:bg-elevated/70">
      <div
        className={`${compact ? "h-[44px] w-[30px]" : "h-[68px] w-[46px]"} shrink-0 overflow-hidden rounded-lg`}
      >
        <Poster src={d.poster ?? undefined} seed={d.metaId} ratio="portrait" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[14.5px] font-semibold text-ink">
            {compact ? (d.subtitle ?? d.title) : d.title}
          </span>
          {!compact && d.subtitle && (
            <span className="shrink-0 truncate text-[12px] text-ink-subtle">{d.subtitle}</span>
          )}
        </div>
        {downloading ? (
          <>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink/10">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ease-out ${d.paused ? "bg-ink/35" : "bg-accent"}`}
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-2 text-[11.5px] tabular-nums text-ink-muted">
              <span>{pct}%</span>
              {d.totalBytes != null && (
                <span className="text-ink-subtle">
                  {fmtBytes(d.receivedBytes)} / {fmtBytes(d.totalBytes)}
                </span>
              )}
              {noteText(d, t) && <span className="text-amber-300/85">· {noteText(d, t)}</span>}
              {fmtSpeed(d.bytesPerSec) && <span>· {fmtSpeed(d.bytesPerSec)}</span>}
              {fmtEta(d, t) && <span className="text-ink-subtle">· {fmtEta(d, t)}</span>}
              {ANDROID && <SubsInfo d={d} />}
            </div>
          </>
        ) : (
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px]">
            {d.status === "done" && (
              <>
                <Check size={13} className="text-accent" strokeWidth={2.6} />
                <span className="text-ink-muted">
                  {t("Saved")}{d.streamLabel ? ` · ${d.streamLabel}` : ""}
                  {d.totalBytes ? ` · ${fmtBytes(d.totalBytes)}` : ""}
                </span>
              </>
            )}
            {d.status === "done" && ANDROID && <SubsInfo d={d} />}
            {d.status === "error" && <span className="text-danger">{errorText(d, t)}</span>}
            {d.status === "canceled" && <span className="text-ink-subtle">{t("Canceled")}</span>}
            {d.status === "interrupted" && (
              <span className="text-amber-300/85">{t("Interrupted: re-download to finish")}</span>
            )}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {downloading ? (
          <>
            {ANDROID &&
              d.code !== "relinking" &&
              (d.paused ? (
                <RowBtn label={t("Resume download")} onClick={() => resumeDownload(d.id)}>
                  <Play size={16} strokeWidth={2.2} fill="currentColor" />
                </RowBtn>
              ) : (
                <RowBtn label={t("Pause download")} onClick={() => pauseDownload(d.id)}>
                  <Pause size={16} strokeWidth={2.2} fill="currentColor" />
                </RowBtn>
              ))}
            <RowBtn label={t("Cancel download")} onClick={() => cancelDownload(d.id)}>
              <X size={16} strokeWidth={2.2} />
            </RowBtn>
          </>
        ) : (
          <>
            {ANDROID && d.status === "error" && d.retryable !== false && (
              <RowBtn label={t("Retry download")} onClick={() => resumeDownload(d.id)}>
                <RotateCw size={16} strokeWidth={2.2} />
              </RowBtn>
            )}
            {d.status === "done" && (
              <>
                <RowBtn label={t("Play")} onClick={playLocal}>
                  <Play size={16} strokeWidth={2.2} fill="currentColor" />
                </RowBtn>
                {!ANDROID && (
                  <RowBtn label={t("Show in folder")} onClick={() => void revealDownload(d.id)}>
                    <FolderOpen size={16} strokeWidth={2} />
                  </RowBtn>
                )}
              </>
            )}
            {confirmDelete ? (
              <button
                type="button"
                onClick={() => removeDownload(d.id)}
                className="h-9 rounded-lg bg-danger/90 px-3 text-[12.5px] font-semibold text-white"
              >
                {t("Delete")}
              </button>
            ) : (
              <RowBtn label={t("Delete download and file")} onClick={() => setConfirmDelete(true)}>
                <Trash2 size={16} strokeWidth={2} />
              </RowBtn>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/** Android: how many subtitles are saved with the video, with a retry when there are none. */
function SubsInfo({ d }: { d: DownloadItem }) {
  const t = useT();
  if (d.subsState === "searching") return <span className="text-ink-subtle">· {t("finding subtitles…")}</span>;
  const n = d.subsCount ?? 0;
  if (n > 0) return <span className="text-ink-subtle">· {n === 1 ? t("1 subtitle") : t("{count} subtitles", { count: n })}</span>;
  return (
    <button
      type="button"
      onClick={() => fetchDownloadSubtitles(d.id)}
      className="ms-1 rounded-md bg-accent/15 px-2 py-0.5 text-[11.5px] font-semibold text-accent"
    >
      {t("Get subtitles")}
    </button>
  );
}

function RowBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-ink/10 hover:text-ink"
    >
      {children}
    </button>
  );
}
