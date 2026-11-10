// "Download season": for every episode, run the same stream query + ranking the source
// picker uses, take the best stream that can actually be saved, resolve it (debrid /
// direct) and queue the download. Runs one episode at a time, and keeps running when you
// leave the page (or, on Android, the app).
import { useSyncExternalStore } from "react";
import type { Meta } from "@/lib/cinemeta";
import type { DebridStore } from "@/lib/debrid/types";
import type { Settings } from "@/lib/settings";
import { runPipeline } from "@/lib/streams/pipeline";
import { resolveStream } from "@/lib/streams/resolve";
import { buildStreamIds } from "@/lib/streams/stream-ids";
import type { ScoredStream } from "@/lib/streams/types";
import { tmdbImdbId } from "@/lib/providers/tmdb";
import type { PlayEpisode } from "@/lib/view";
import { loadPickerAddons } from "@/views/play-picker/use-addons";
import { buildPipelineInput } from "@/views/play-picker/use-pipeline-result";
import { activeDownloadFor, beginBackgroundJob, endBackgroundJob, enqueueDownload } from "./downloads-store";
import { isAndroidApp, nativeNetworkLooksDown, subscribeNativeNetwork } from "@/lib/android";
import { readActiveStremioAuthKey } from "@/lib/auth";
import { buildDebridClients } from "@/lib/debrid/registry";
import { loadStoredSettings } from "@/lib/settings/load";

export type SeasonDownloadProgress = {
  total: number;
  done: number;
  queued: number;
  skipped: number;
  failed: PlayEpisode[];
  current: PlayEpisode | null;
  finished: boolean;
};

/** The user's debrid services that already hold this stream (cached there, or in their library). */
function heldBy(s: ScoredStream, debrids: DebridStore[]): DebridStore[] {
  return debrids.filter((d) => s.cached?.[d.slug] === true || s.inLibrary?.[d.slug] === true);
}

/**
 * Streams worth trying for a download, best first: cached on a debrid or a direct link. An
 * uncached torrent is never tried: it can't be saved right now, and asking a debrid for it
 * leaves the torrent queued in the user's account (TorBox, AllDebrid).
 */
function downloadCandidates(all: ScoredStream[], debrids: DebridStore[]): ScoredStream[] {
  const direct = (s: ScoredStream) => !!s.url && s.url !== "#" && !s.infoHash;
  return all.filter((s) => heldBy(s, debrids).length > 0 || direct(s)).slice(0, 4);
}

export async function downloadSeason(opts: {
  meta: Meta;
  episodes: PlayEpisode[];
  authKey: string | null;
  settings: Settings;
  debrids: DebridStore[];
  signal: AbortSignal;
  onProgress: (p: SeasonDownloadProgress) => void;
}): Promise<SeasonDownloadProgress> {
  const { meta, episodes, authKey, settings, debrids, signal, onProgress } = opts;
  const state: SeasonDownloadProgress = {
    total: episodes.length,
    done: 0,
    queued: 0,
    skipped: 0,
    failed: [],
    current: null,
    finished: false,
  };
  // The list can grow while this runs (a second request for the same season adds what is missing).
  const emit = () => onProgress({ ...state, total: episodes.length, failed: [...state.failed] });
  emit();

  const { addons } = await loadPickerAddons(authKey, settings);
  let imdbId: string | null = meta.id.startsWith("tt") ? meta.id : null;
  if (!imdbId && settings.tmdbKey) imdbId = await tmdbImdbId(settings.tmdbKey, meta.id).catch(() => null);

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    if (signal.aborted) break;
    state.current = ep;
    emit();
    // Already saved or downloading: don't fetch it twice.
    const existing = activeDownloadFor(meta.id, ep.season, ep.episode);
    if (existing && existing.status !== "error" && existing.status !== "canceled") {
      state.skipped++;
      state.done++;
      emit();
      continue;
    }
    let ok = false;
    try {
      const streamIds = buildStreamIds(meta.id, ep, imdbId, meta.behaviorHints?.defaultVideoId);
      if (streamIds.length > 0) {
        const result = await runPipeline(
          buildPipelineInput({
            meta,
            episode: ep,
            imdbId,
            streamIds,
            addons,
            debrids,
            settings,
            strictMode: settings.streamFilterLevel === "strict",
            filterDisabled: settings.streamFilterLevel === "off",
          }),
          signal,
        );
        for (const s of downloadCandidates(result.picker.all, debrids)) {
          if (signal.aborted) break;
          // Only the services that already have it, and not as a "start this torrent" request.
          const r = await resolveStream(s, heldBy(s, debrids), signal, false);
          if (!r.ok) continue;
          const label =
            [s.resolution, s.source].filter(Boolean).join(" ") || s.parsedTitle || s.title || s.name || s.addonName || null;
          await enqueueDownload({
            meta,
            episode: ep,
            streamLabel: label,
            url: r.data.url,
            rawUrl: r.data.url,
            headers: r.data.headers,
            subtitles: r.data.subtitles,
            source: s,
          });
          ok = true;
          break;
        }
      }
    } catch (e) {
      if (signal.aborted) break;
      console.warn("[season-download] episode failed", ep, e);
    }
    if (ok) state.queued++;
    else state.failed.push(ep);
    state.done++;
    emit();
  }
  state.current = null;
  state.finished = true;
  emit();
  return state;
}

// ---- running season downloads ---------------------------------------------------------
// Held here rather than in the button, so leaving the show's page doesn't stop the queue.

type SeasonJob = {
  key: string;
  title: string;
  season: number | null;
  /** The queue the job walks through; a second request for the same season appends to it. */
  episodes: PlayEpisode[];
  progress: SeasonDownloadProgress;
  ac: AbortController;
};

const jobs = new Map<string, SeasonJob>();
const jobListeners = new Set<() => void>();
let jobList: SeasonJob[] = [];

function notifyJobs() {
  jobList = [...jobs.values()];
  jobListeners.forEach((l) => l());
}

function subscribeJobs(l: () => void) {
  jobListeners.add(l);
  return () => {
    jobListeners.delete(l);
  };
}

export function seasonJobKey(metaId: string, episodes: PlayEpisode[]): string {
  return `${metaId}|s${episodes[0]?.season ?? ""}`;
}

// Android: the queue lives in the page, which goes away when the app is swiped out of Recents.
// The episodes still to do are kept in storage and picked up on the next start.
const SAVED_JOBS_KEY = "harbor.seasonJobs";
type SavedJob = { key: string; meta: Meta; episodes: PlayEpisode[] };

function readSavedJobs(): SavedJob[] {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_JOBS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as SavedJob[]).filter((j) => j && typeof j.key === "string" && Array.isArray(j.episodes)) : [];
  } catch {
    return [];
  }
}

function saveJob(key: string, meta: Meta, episodes: PlayEpisode[] | null) {
  if (!isAndroidApp()) return;
  try {
    const rest = readSavedJobs().filter((j) => j.key !== key);
    if (episodes && episodes.length > 0) {
      const slim = { id: meta.id, type: meta.type, name: meta.name, poster: meta.poster, behaviorHints: meta.behaviorHints, releaseInfo: meta.releaseInfo } as Meta;
      rest.push({ key, meta: slim, episodes });
    }
    localStorage.setItem(SAVED_JOBS_KEY, JSON.stringify(rest));
  } catch {
    /* storage full: the queue just won't survive a restart */
  }
}

function offline(): boolean {
  return (typeof navigator !== "undefined" && navigator.onLine === false) || nativeNetworkLooksDown();
}

let waitingForNetwork = false;
/** Back online by any signal (the WebView's "online", a native request that works again, or a
 *  check every 20 s): resume then. A single "online" event is not enough: on a Wi-Fi without
 *  internet it never fires, and it can come before the native requests work again. */
function waitForNetworkThenResume(): void {
  if (waitingForNetwork) return;
  waitingForNetwork = true;
  let timer = 0;
  const stop = () => {
    waitingForNetwork = false;
    window.removeEventListener("online", check);
    unsubscribe();
    window.clearInterval(timer);
  };
  const check = () => {
    if (offline()) return;
    stop();
    resumeSavedSeasonJobs();
  };
  window.addEventListener("online", check);
  const unsubscribe = subscribeNativeNetwork(check);
  timer = window.setInterval(check, 20_000);
}

/**
 * On start (Android): carry on with season queues the app was closed in the middle of. Offline
 * (a train, airplane mode) it waits for the connection: started then, every episode would fail
 * and the queue would be dropped.
 */
export function resumeSavedSeasonJobs(): void {
  const saved = readSavedJobs();
  if (saved.length === 0) return;
  if (offline()) {
    waitForNetworkThenResume();
    return;
  }
  const settings = loadStoredSettings();
  const debrids = buildDebridClients({ rdKey: settings.rdKey, tbKey: settings.tbKey, adKey: settings.adKey, pmKey: settings.pmKey, dlKey: settings.dlKey });
  for (const j of saved) {
    startSeasonDownload(j.key, { meta: j.meta, episodes: j.episodes, authKey: readActiveStremioAuthKey(), settings, debrids });
  }
}

export function startSeasonDownload(
  key: string,
  opts: Omit<Parameters<typeof downloadSeason>[0], "signal" | "onProgress">,
): void {
  const cur = jobs.get(key);
  if (cur && !cur.progress.finished) {
    // The season is already being worked on (the key is the title and season, not the exact
    // list): add the episodes the running job doesn't have, instead of dropping the request.
    const missing = opts.episodes.filter(
      (e) => !cur.episodes.some((x) => x.season === e.season && x.episode === e.episode),
    );
    if (missing.length === 0) return;
    cur.episodes.push(...missing);
    cur.progress = { ...cur.progress, total: cur.episodes.length };
    saveJob(key, opts.meta, cur.episodes.slice(cur.progress.done));
    notifyJobs();
    return;
  }
  const episodes = [...opts.episodes];
  saveJob(key, opts.meta, episodes);
  const ac = new AbortController();
  const job: SeasonJob = {
    key,
    title: opts.meta.name ?? "",
    season: episodes[0]?.season ?? null,
    episodes,
    ac,
    progress: { total: episodes.length, done: 0, queued: 0, skipped: 0, failed: [], current: null, finished: false },
  };
  jobs.set(key, job);
  notifyJobs();
  const bgKey = `season:${key}`;
  beginBackgroundJob(bgKey);
  void downloadSeason({
    ...opts,
    episodes,
    signal: ac.signal,
    onProgress: (p) => {
      job.progress = p;
      // Episodes handled so far (queued, skipped or failed) are done; keep the rest.
      saveJob(key, opts.meta, episodes.slice(p.done));
      notifyJobs();
    },
  })
    .catch((e: unknown) => console.warn("[season-download] stopped", e))
    .finally(() => {
      // Stopped by the user or finished: nothing to pick up later (if the app is closed, this
      // never runs and the saved rest stays). Episodes that failed while the connection was down
      // stay saved, so the next start tries them again.
      const retryLater = !ac.signal.aborted && offline() ? job.progress.failed : [];
      saveJob(key, opts.meta, retryLater.length > 0 ? retryLater : null);
      job.progress = { ...job.progress, current: null, finished: true };
      endBackgroundJob(bgKey);
      notifyJobs();
      // Keep the summary up for a moment, then forget the job.
      window.setTimeout(() => {
        if (jobs.get(key) !== job) return;
        jobs.delete(key);
        notifyJobs();
      }, 10_000);
    });
}

export function stopSeasonDownload(key: string): void {
  jobs.get(key)?.ac.abort();
}

export function useSeasonDownload(key: string): SeasonDownloadProgress | null {
  return useSyncExternalStore(subscribeJobs, () => jobs.get(key)?.progress ?? null);
}

/** Season queues still looking for sources (Downloads page). */
export function useRunningSeasonJobs(): { key: string; title: string; season: number | null; progress: SeasonDownloadProgress }[] {
  const all = useSyncExternalStore(subscribeJobs, () => jobList);
  return all.filter((j) => !j.progress.finished);
}
