import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MOVIE_GENRES } from "@/lib/feed/tags";
import { useParental } from "@/lib/parental";
import {
  detectIntent,
  searchAll,
  searchAnime,
  searchCinemeta,
  searchLiveTvChannels,
  type AnimeHit,
  type SearchResults,
} from "@/lib/search";
import { searchAddonCatalogs, searchAddonGroups, mergeMetas, type AddonResultGroup } from "@/lib/search-addons";
import { createSearchRun } from "@/lib/search-net";
import type { Meta } from "@/lib/cinemeta";
import { searchAddonIndex } from "@/lib/search-addon-index";
import { gatherCatalogAddons, type Addon } from "@/lib/addons";
import { useAuth } from "@/lib/auth";
import { useSettings } from "@/lib/settings";

type SearchState = {
  open: boolean;
  query: string;
  results: SearchResults | null;
  status: "idle" | "typing" | "loading" | "done";
  recent: string[];
};

type SearchValue = SearchState & {
  setOpen: (open: boolean) => void;
  setQuery: (q: string) => void;
  clear: () => void;
  recordRecent: (q: string) => void;
  removeRecent: (q: string) => void;
  clearRecent: () => void;
};

const Ctx = createContext<SearchValue | null>(null);
const CACHE_TTL_MS = 3 * 60_000;
const CACHE_MAX = 40;

function emptyResults(query: string): SearchResults {
  return { query, topMatch: null, people: [], movies: [], series: [], liveTv: [], anime: [], addonGroups: [], addons: [], intent: null };
}
const RECENT_KEY = "harbor.search.recent";
const MAX_RECENT = 8;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function saveRecent(items: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, MAX_RECENT)));
  } catch {
    /* noop */
  }
}

export function SearchProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const { authKey } = useAuth();
  const { hiddenTabs } = useParental();
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [status, setStatus] = useState<SearchState["status"]>("idle");
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const debounceRef = useRef<number | null>(null);
  const reqIdRef = useRef(0);
  const addonsRef = useRef<{ key: string | null; addons: Addon[] } | null>(null);
  const ensureAddons = useCallback(async (): Promise<Addon[]> => {
    if (addonsRef.current && addonsRef.current.key === authKey) return addonsRef.current.addons;
    const a = await gatherCatalogAddons(authKey).catch(() => [] as Addon[]);
    addonsRef.current = { key: authKey, addons: a };
    return a;
  }, [authKey]);

  useEffect(() => {
    const onAddonsChanged = () => {
      addonsRef.current = null;
    };
    window.addEventListener("harbor:addons-changed", onAddonsChanged);
    return () => window.removeEventListener("harbor:addons-changed", onAddonsChanged);
  }, []);

  const excludeGenres = useMemo(() => {
    const ids: number[] = [];
    if (hiddenTabs.anime) ids.push(MOVIE_GENRES.Animation);
    return ids;
  }, [hiddenTabs.anime]);

  // Searches seen recently: typing, backspacing or coming back to a query is instant.
  const cacheRef = useRef(new Map<string, { at: number; results: SearchResults }>());
  const abortRef = useRef<AbortController | null>(null);

  // Opening search: have the addon list ready, so the first search doesn't wait for it.
  useEffect(() => {
    if (open) void ensureAddons();
  }, [open, ensureAddons]);

  useEffect(() => {
    const trimmed = query.trim();
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (!trimmed) {
      // Nothing to search: forget any search still in flight so it can't show up later.
      reqIdRef.current += 1;
      abortRef.current?.abort();
      setResults(null);
      setStatus("idle");
      return;
    }
    setStatus("typing");
    const animeAllowed = !hiddenTabs.anime;
    const liveTvAllowed = !hiddenTabs.liveTv && settings.iptvPlaylists.length > 0;
    const cacheKey = `${trimmed.toLowerCase()}|${settings.tmdbKey ? 1 : 0}|${animeAllowed ? 1 : 0}|${liveTvAllowed ? settings.iptvPlaylists.length : 0}|${excludeGenres.join(",")}|${authKey ?? ""}`;
    debounceRef.current = window.setTimeout(() => {
      const id = ++reqIdRef.current;
      abortRef.current?.abort();
      const hit = cacheRef.current.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        setResults(hit.results);
        setStatus("done");
        return;
      }
      const ac = new AbortController();
      abortRef.current = ac;
      const run = createSearchRun(ac.signal);
      setStatus("loading");

      // What has arrived so far. Every source reports in on its own, so nothing waits for the
      // slowest one (or for TMDB), and the search only counts as finished when all are.
      const acc = {
        tmdb: null as SearchResults | null,
        anime: [] as AnimeHit[],
        addon: { movies: [], series: [] } as { movies: Meta[]; series: Meta[] },
        cine: { movies: [], series: [] } as { movies: Meta[]; series: Meta[] },
        groups: [] as AddonResultGroup[],
      };
      const liveTv = liveTvAllowed ? searchLiveTvChannels(trimmed, settings.iptvPlaylists) : [];
      const pending = new Set<string>();
      const publish = () => {
        if (id !== reqIdRef.current) return;
        const base = acc.tmdb ?? emptyResults(trimmed);
        const mergedMovies = mergeMetas(mergeMetas(base.movies, acc.addon.movies), acc.cine.movies);
        const mergedSeries = mergeMetas(mergeMetas(base.series, acc.addon.series), acc.cine.series);
        const shown = new Set<string>([...mergedMovies, ...mergedSeries].map((m) => m.id));
        const dedupedGroups = acc.groups
          .map((g) => ({ ...g, metas: g.metas.filter((m) => !shown.has(m.id)) }))
          .filter((g) => g.metas.length > 0);
        const next: SearchResults = {
          ...base,
          movies: mergedMovies,
          series: mergedSeries,
          liveTv,
          anime: acc.anime,
          addonGroups: dedupedGroups,
          addons: searchAddonIndex(trimmed),
          intent: base.intent ?? detectIntent(trimmed),
        };
        setResults(next);
        const finished = pending.size === 0;
        setStatus(finished ? "done" : "loading");
        if (finished) {
          const cache = cacheRef.current;
          cache.set(cacheKey, { at: Date.now(), results: next });
          while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
        }
      };
      const track = <T,>(name: string, p: Promise<T>, apply: (v: T) => void) => {
        pending.add(name);
        p.then(apply)
          .catch(() => {})
          .finally(() => {
            pending.delete(name);
            publish();
          });
      };

      // Quick, reliable sources first (they get the first network slots), slow ones after.
      track("cinemeta", searchCinemeta(trimmed, run), (c) => {
        acc.cine = c;
      });
      track("tmdb", searchAll(settings.tmdbKey, trimmed, { excludeGenres }), (r) => {
        acc.tmdb = r;
      });
      if (animeAllowed) {
        track("anime", searchAnime(trimmed, 8, run), (a) => {
          acc.anime = a;
        });
      }
      const addonsP = ensureAddons();
      track("addon", addonsP.then((a) => searchAddonCatalogs(a, trimmed, run)), (a) => {
        acc.addon = a;
      });
      track("groups", addonsP.then((a) => searchAddonGroups(a, trimmed, run)), (g) => {
        acc.groups = g;
      });
    }, 150);
  }, [query, settings.tmdbKey, settings.iptvPlaylists, excludeGenres, hiddenTabs.anime, hiddenTabs.liveTv, authKey, ensureAddons]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = (e.key ?? "").toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const setQuery = useCallback((q: string) => setQueryState(q), []);

  const clear = useCallback(() => {
    reqIdRef.current += 1;
    abortRef.current?.abort();
    setQueryState("");
    setResults(null);
    setStatus("idle");
  }, []);

  const recordRecent = useCallback((q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setRecent((prev) => {
      const next = [trimmed, ...prev.filter((p) => p.toLowerCase() !== trimmed.toLowerCase())].slice(0, MAX_RECENT);
      saveRecent(next);
      return next;
    });
  }, []);

  const removeRecent = useCallback((q: string) => {
    setRecent((prev) => {
      const next = prev.filter((p) => p !== q);
      saveRecent(next);
      return next;
    });
  }, []);

  const clearRecent = useCallback(() => {
    setRecent([]);
    saveRecent([]);
  }, []);

  const value = useMemo(
    () => ({ open, setOpen, query, setQuery, results, status, recent, clear, recordRecent, removeRecent, clearRecent }),
    [open, query, results, status, recent, setQuery, clear, recordRecent, removeRecent, clearRecent],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSearch(): SearchValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSearch outside SearchProvider");
  return v;
}
