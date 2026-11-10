import { ListFilter, Search } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { usePlaylistMutations } from "./live/hooks/use-playlist-mutations";
import { useLiveActions } from "./live/hooks/use-live-actions";
import { confirmDialog } from "@/lib/dialog";
import { useT } from "@/lib/i18n";
import { useSettings } from "@/lib/settings";
import { useScrollMemory, useView } from "@/lib/view";
import { FAVORITES_GROUP_KEY, useFavorites } from "@/lib/iptv/favorites";
import { clearPlaylistCache, getCachedPlaylist } from "@/lib/iptv/store";
import { pushActivityHint } from "@/lib/discord/activity-hint";
import type { IptvChannel, IptvPlaylistSource } from "@/lib/iptv/types";
import { CategoryDrawer } from "./live/category-drawer";
import { CategorySidebar } from "./live/category-sidebar";
import { ChannelGrid, EmptyResult, ErrorBlock } from "./live/channel-grid";
import { GridSkeleton, GuideSkeleton } from "./live/skeletons";
import { PlaylistEmpty } from "./live/playlist-empty";
import { SourcePicker } from "./live/source-picker";
import { LiveHome } from "./live/live-home";
import { TopNetworksRows } from "./live/top-networks-rows";
import { GuideView } from "./live/guide/guide-view";
import { useAllPlaylists } from "./live/hooks/use-all-playlists";
import { useChannelPipeline } from "./live/hooks/use-channel-pipeline";
import { useEpg, useNowTick } from "./live/hooks/use-epg";
import { useXtreamEpgFallback } from "./live/hooks/use-xtream-epg-fallback";
import { useIptvPlaylist } from "./live/hooks/use-iptv-playlist";
import { MultiviewView } from "./multiview";
import { ViewModeToggle, type ViewMode } from "./live/view-mode-toggle";
import { isPhoneLayout, isWindowsDesktop } from "@/lib/platform";
import { useNativeLive } from "./live/use-native-live";
import { SportsCustomizeModal } from "./live/live-home/sports/sports-customize-modal";
import { DEFAULT_SPORTS_LEAGUES, LEAGUES, LEAGUE_GROUPS, getGroupLabel, getLeagueLabel } from "@/lib/sports/espn";
import { useNativeSheet } from "@/views/native/native-screens";

const ACTIVE_KEY = "harbor.iptv.active";
const MODE_KEY = "harbor.iptv.viewMode";
const EMPTY_CHANNELS: IptvChannel[] = [];

// Android app: the 220px categories column left half of a phone for the channels (the header and
// the list ran off the screen), so there it is a drawer opened from a button next to the search.
const PHONE = isPhoneLayout();

function readActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function writeActiveId(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}

function readMode(): ViewMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "grid") return "grid";
    if (v === "guide") return "guide";
    if (v === "multiview" && isWindowsDesktop()) return "multiview";
    return "home";
  } catch {
    return "home";
  }
}

function writeMode(m: ViewMode) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {}
}

export function LiveView({ active }: { active: boolean }) {
  const t = useT();
  const { settings, update } = useSettings();
  const { openMeta, topKind } = useView();
  const sources = settings.iptvPlaylists;

  const [activeId, setActiveId] = useState<string | null>(() => readActiveId());
  useEffect(() => {
    // An EPG-only entry (a guide link, no channels) is not a playlist to open: it used to be
    // picked when it came first in the list, and the page then failed on its empty link.
    const playlists = sources.filter((s) => (s.kind ?? "m3u") !== "epg");
    if (playlists.length === 0) {
      if (activeId !== null) {
        setActiveId(null);
        writeActiveId(null);
      }
      return;
    }
    if (!activeId || !playlists.find((s) => s.id === activeId)) {
      const fallback = playlists[0]?.id ?? null;
      setActiveId(fallback);
      writeActiveId(fallback);
    }
  }, [sources, activeId]);

  const activeSource: IptvPlaylistSource | null = useMemo(() => {
    if (!activeId) return null;
    const found = sources.find((s) => s.id === activeId);
    return found
      ? { id: found.id, name: found.name, url: found.url, epgUrl: found.epgUrl, kind: found.kind, xtream: found.xtream }
      : null;
  }, [activeId, sources]);

  const { state, refresh } = useIptvPlaylist(active ? activeSource : null);
  const cachedForActive = getCachedPlaylist(activeSource?.id ?? "");
  const playlist =
    state.kind === "ready"
      ? state.playlist
      : cachedForActive && cachedForActive.id === activeId
        ? cachedForActive
        : null;
  const epgOnlyUrls = useMemo(
    () => sources.filter((s) => s.kind === "epg").map((s) => s.epgUrl || s.url),
    [sources],
  );
  const { index: baseEpg, error: epgError } = useEpg(active ? activeSource : null, epgOnlyUrls);
  const epg = useXtreamEpgFallback(activeSource, playlist?.channels ?? EMPTY_CHANNELS, baseEpg);
  const nowMs = useNowTick(30_000);

  const favorites = useFavorites();
  const favoritesCountRef = useRef(favorites.count);
  favoritesCountRef.current = favorites.count;
  const [group, setGroup] = useState<string | null>(
    () => (favoritesCountRef.current > 0 ? FAVORITES_GROUP_KEY : null),
  );
  const [query, setQuery] = useState("");
  // The box shows each key at once; filtering thousands of channels follows at low priority
  // (100-200 ms a key on a slow phone with 11k channels when it ran in the same render).
  const listQuery = useDeferredValue(query);
  const [mode, setModeState] = useState<ViewMode>(() => readMode());
  const setMode = useCallback((m: ViewMode) => {
    setModeState(m);
    writeMode(m);
  }, []);
  const [immersive, setImmersive] = useState(false);
  useEffect(() => {
    const onImm = (e: Event) => setImmersive((e as CustomEvent<boolean>).detail === true);
    window.addEventListener("harbor:immersive", onImm);
    return () => window.removeEventListener("harbor:immersive", onImm);
  }, []);
  useEffect(() => {
    if (mode !== "multiview" && immersive) setImmersive(false);
  }, [mode, immersive]);
  useEffect(() => {
    setGroup(favoritesCountRef.current > 0 ? FAVORITES_GROUP_KEY : null);
    setQuery("");
  }, [activeId]);
  const [catsOpen, setCatsOpen] = useState(false);
  const closeCats = useCallback(() => setCatsOpen(false), []);
  useEffect(() => {
    setCatsOpen(false);
  }, [activeId, mode]);

  const region = settings.region || "US";
  const preferredLanguages = settings.preferredLanguages.length > 0
    ? settings.preferredLanguages
    : ["English"];

  const inFavorites = group === FAVORITES_GROUP_KEY;
  const allSources = useMemo<IptvPlaylistSource[]>(
    () =>
      settings.iptvPlaylists
        .filter((p) => (p.kind ?? "m3u") !== "epg")
        .map((p) => ({
          id: p.id,
          name: p.name,
          url: p.url,
          epgUrl: p.epgUrl,
          kind: p.kind,
          xtream: p.xtream,
        })),
    [settings.iptvPlaylists],
  );
  const managedSources = useMemo<IptvPlaylistSource[]>(
    () =>
      settings.iptvPlaylists.map((p) => ({
        id: p.id,
        name: p.name,
        url: p.url,
        epgUrl: p.epgUrl,
        kind: p.kind,
        xtream: p.xtream,
      })),
    [settings.iptvPlaylists],
  );
  const stubSources = useMemo(() => {
    const ids = new Set<string>();
    for (const f of favorites.items.values()) if (!f.url) ids.add(f.sourceId);
    return allSources.filter((s) => ids.has(s.id));
  }, [favorites.items, allSources]);

  const multiview = mode === "multiview";
  const allPlaylists = useAllPlaylists(
    multiview ? allSources : stubSources,
    multiview || (inFavorites && stubSources.length > 0),
  );

  const {
    sortedGroups,
    topRows,
    showTopRows,
    regionChannels,
    shownChannels,
    mvChannels,
    visible,
    counts,
    groupLogos,
  } = useChannelPipeline({
    playlist,
    region,
    preferredLanguages,
    mode,
    group,
    query: listQuery,
    favorites,
    allPlaylists,
    allSources,
  });

  const selectActive = useCallback((id: string | null) => {
    setActiveId(id);
    writeActiveId(id);
  }, []);
  // Opening a playlist from the picker. An EPG-only entry is listed there to edit or delete
  // it, not to open.
  const openPlaylist = useCallback(
    (id: string) => {
      if (allSources.some((s) => s.id === id)) selectActive(id);
    },
    [allSources, selectActive],
  );

  const { addPlaylist, removePlaylist, editPlaylist, renamePlaylist, reorderPlaylist, movePlaylistTop } =
    usePlaylistMutations({ activeId, setActiveId: selectActive, refresh });
  const [editRequest, setEditRequest] = useState<{ id: string; nonce: number } | null>(null);

  const { handlePlay, handlePlayCatchup, exportPlaylist } = useLiveActions({
    epg,
    activeId,
    playlist,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollMemory("live", scrollRef, active);

  useEffect(() => {
    if (!active || mode !== "guide") return;
    return pushActivityHint({ details: "Browsing the TV guide", state: "Live TV" });
  }, [active, mode]);

  const hasCategories =
    !!playlist && sortedGroups.length > 0 && mode !== "multiview" && mode !== "home" && state.kind !== "error";
  const catsLabel =
    group === null ? t("Categories") : group === FAVORITES_GROUP_KEY ? t("Favorites") : group;

  // Android: drawn natively (see ./live/use-native-live). The page's own playlist picker,
  // categories drawer and leagues window open over it (it steps aside) for what the native
  // menus below don't cover.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerRequest, setPickerRequest] = useState(0);
  const [sportsOpen, setSportsOpen] = useState(false);
  // The playlists as the screen's own menu: switch, refresh; adding, editing and the rest open
  // the page's picker (its forms).
  const [plSheet, setPlSheet] = useState(false);
  const [addRequest, setAddRequest] = useState(0);
  useNativeSheet(
    plSheet ? `live-playlists:${activeId}` : null,
    [
      // The playlists to switch to (EPG-only entries are not among them; "Manage" lists them).
      ...allSources.map((src) => ({
        id: `pl:${src.id}`,
        label: src.name,
        active: src.id === activeId,
        onSelect: () => selectActive(src.id),
      })),
      { id: "-", label: "", divider: true },
      {
        id: "refresh",
        label: t("Refresh playlist"),
        icon: "retry",
        onSelect: () => {
          if (activeId) clearPlaylistCache(activeId);
          refresh();
        },
      },
      ...(activeId ? [{ id: "edit", label: t("Edit link & login"), icon: "pencil", onSelect: () => setEditRequest({ id: activeId, nonce: Date.now() }) }] : []),
      { id: "add", label: t("Add another playlist"), icon: "plus", onSelect: () => setAddRequest((n) => n + 1) },
      { id: "manage", label: `${t("Rename")} · ${t("Delete")} · ${t("Move up")}…`, icon: "list-checks", onSelect: () => setPickerRequest((n) => n + 1) },
    ],
    () => setPlSheet(false),
  );
  // The categories and the leagues as the screen's own menus (sliding up from the bottom); the
  // page's drawer only to filter, hide or pin categories ("Manage").
  const [catsWeb, setCatsWeb] = useState(false);
  const total = useMemo(() => Array.from(counts.values()).reduce((a, b) => a + b, 0), [counts]);
  const catsNative = useNativeSheet(
    catsOpen && !catsWeb ? `live-cats:${activeId}` : null,
    [
      ...(favorites.count > 0
        ? [{ id: FAVORITES_GROUP_KEY, label: `${t("Favorites")}  ${favorites.count}`, icon: "star", active: group === FAVORITES_GROUP_KEY, onSelect: () => setGroup(FAVORITES_GROUP_KEY) }]
        : []),
      { id: "*", label: `${t("All channels")}  ${total}`, active: group === null, onSelect: () => setGroup(null) },
      ...sortedGroups.map((g) => ({ id: `g:${g}`, label: `${g}  ${counts.get(g) ?? 0}`, active: group === g, onSelect: () => setGroup(g) })),
      { id: "-", label: "", divider: true },
      { id: "manage", label: `${t("Categories")} · ${t("Manage")}`, icon: "list-checks", stay: true, onSelect: () => setCatsWeb(true) },
    ],
    () => {
      if (!catsWeb) setCatsOpen(false);
    },
  );
  useEffect(() => {
    if (!catsOpen) setCatsWeb(false);
  }, [catsOpen]);
  const savedLeagues = settings.sportsLeagues?.length ? settings.sportsLeagues : DEFAULT_SPORTS_LEAGUES;
  const [leagueDraft, setLeagueDraft] = useState<Set<string>>(() => new Set(savedLeagues));
  useEffect(() => {
    if (sportsOpen) setLeagueDraft(new Set(savedLeagues));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sportsOpen]);
  const sportsNative = useNativeSheet(
    sportsOpen ? "live-leagues" : null,
    [
      {
        id: "save",
        label: `${t("sports.customize.save")}  ·  ${t("sports.customize.selected", { n: leagueDraft.size })}`,
        icon: "check",
        onSelect: () => update({ sportsLeagues: [...leagueDraft] }),
      },
      { id: "-", label: "", divider: true },
      ...LEAGUE_GROUPS.flatMap((g) => {
        const keys = LEAGUES.filter((l) => l.group === g.key).map((l) => l.key);
        if (keys.length === 0) return [];
        const all = keys.every((k) => leagueDraft.has(k));
        return [
          {
            id: `grp:${g.key}`,
            label: `${g.icon}  ${getGroupLabel(g)}`,
            active: all,
            stay: true,
            onSelect: () =>
              setLeagueDraft((prev) => {
                const next = new Set(prev);
                if (all) keys.forEach((k) => next.delete(k));
                else keys.forEach((k) => next.add(k));
                return next;
              }),
          },
          ...LEAGUES.filter((l) => l.group === g.key).map((l) => ({
            id: `lg:${l.key}`,
            label: getLeagueLabel(l),
            indent: true,
            active: leagueDraft.has(l.key),
            stay: true,
            onSelect: () =>
              setLeagueDraft((prev) => {
                const next = new Set(prev);
                if (next.has(l.key)) next.delete(l.key);
                else next.add(l.key);
                return next;
              }),
          })),
        ];
      }),
    ],
    () => setSportsOpen(false),
  );
  const native = useNativeLive({
    active: active && topKind === "live",
    mode,
    setMode,
    hasSources: allSources.length > 0,
    sourceName: managedSources.find((s) => s.id === activeId)?.name ?? t("No playlist"),
    channelCount: playlist?.channels.length ?? 0,
    stateKind: state.kind,
    errorMessage: state.kind === "error" ? state.message : null,
    onRetry: () => {
      if (activeId) clearPlaylistCache(activeId);
      refresh();
    },
    onOpenPicker: () => setPlSheet(true),
    pickerOpen,
    catsOpen: catsOpen && !catsNative,
    onOpenCats: () => setCatsOpen(true),
    hasCategories: !!playlist && sortedGroups.length > 0 && mode === "grid" && state.kind !== "error",
    catsLabel,
    group,
    setGroup,
    query,
    setQuery,
    shownChannels,
    visible,
    regionChannels,
    topRows,
    showTopRows,
    epg,
    nowMs,
    sourceId: activeId ?? "",
    region,
    favorites,
    hasPlaylist: !!playlist,
    onPlay: handlePlay,
    onInfo: (meta) => openMeta(meta, { liveContext: true }),
    onCustomizeSports: () => setSportsOpen(true),
    onPlayCatchup: handlePlayCatchup,
    sportsOpen: sportsOpen && !sportsNative,
  });
  if (native) {
    return (
      <main data-rail-flush className="relative flex min-h-0 flex-1 flex-col pt-20">
        <header className={`relative z-[40] flex shrink-0 items-center px-4 py-2.5 ${pickerOpen ? "" : "pointer-events-none opacity-0"}`}>
          <SourcePicker
            sources={managedSources}
            activeId={activeId}
            exportEnabled={!!playlist?.channels.length}
            onSelect={openPlaylist}
            onAdd={addPlaylist}
            onEdit={editPlaylist}
            onRename={renamePlaylist}
            onRemove={removePlaylist}
            onMove={reorderPlaylist}
            onMoveTop={movePlaylistTop}
            onRefresh={() => {
              if (activeId) clearPlaylistCache(activeId);
              refresh();
            }}
            onExport={exportPlaylist}
            fetchedAt={playlist?.fetchedAt ?? null}
            channelCount={playlist?.channels.length ?? null}
            loading={state.kind === "loading"}
            editRequest={editRequest}
            openRequest={pickerRequest}
            addRequest={addRequest}
            onOpenChange={setPickerOpen}
          />
        </header>
        {catsOpen && !catsNative && (
          <CategoryDrawer
            groups={sortedGroups}
            active={group}
            onSelect={setGroup}
            onClose={closeCats}
            counts={counts}
            groupLogos={groupLogos}
            favoritesCount={favorites.count}
            sourceId={activeId ?? ""}
          />
        )}
        {sportsOpen && !sportsNative && (
          <SportsCustomizeModal
            selected={settings.sportsLeagues?.length ? settings.sportsLeagues : DEFAULT_SPORTS_LEAGUES}
            onSave={(keys) => update({ sportsLeagues: keys })}
            onClose={() => setSportsOpen(false)}
          />
        )}
      </main>
    );
  }

  // No playlist to open (none saved, or only EPG-only entries): the "add a playlist" page.
  if (allSources.length === 0) {
    return (
      <main data-rail-flush className="relative flex min-h-0 flex-1 flex-col overflow-y-auto pt-20">
        <PlaylistEmpty onSave={(entry) => addPlaylist(entry)} />
      </main>
    );
  }

  return (
    <main data-rail-flush className={`relative flex min-h-0 flex-1 ${immersive ? "pt-0" : "pt-20"}`}>
      {hasCategories && !PHONE && (
        <CategorySidebar
          groups={sortedGroups}
          active={group}
          onSelect={setGroup}
          counts={counts}
          groupLogos={groupLogos}
          favoritesCount={favorites.count}
          sourceId={activeId ?? ""}
        />
      )}
      {hasCategories && PHONE && catsOpen && (
        <CategoryDrawer
          groups={sortedGroups}
          active={group}
          onSelect={setGroup}
          onClose={closeCats}
          counts={counts}
          groupLogos={groupLogos}
          favoritesCount={favorites.count}
          sourceId={activeId ?? ""}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {!immersive && (
        <header
          className={`relative z-[40] flex shrink-0 flex-wrap items-center gap-2.5 border-b border-edge-soft/40 bg-surface py-2.5 ${PHONE ? "px-4" : "px-6"}`}
        >
          <SourcePicker
            sources={managedSources}
            activeId={activeId}
            exportEnabled={!!playlist?.channels.length}
            onSelect={openPlaylist}
            onAdd={addPlaylist}
            onEdit={editPlaylist}
            onRename={renamePlaylist}
            onRemove={removePlaylist}
            onMove={reorderPlaylist}
            onMoveTop={movePlaylistTop}
            onRefresh={() => {
              if (activeId) clearPlaylistCache(activeId);
              refresh();
            }}
            onExport={exportPlaylist}
            fetchedAt={playlist?.fetchedAt ?? null}
            channelCount={playlist?.channels.length ?? null}
            loading={state.kind === "loading"}
            editRequest={editRequest}
          />
          {mode === "multiview" ? (
            <div className="flex h-11 flex-1 min-w-[220px] items-center px-1 text-[13px] text-ink-subtle">
              {t("Pick channels into the grid below. Audio follows the highlighted tile.")}
            </div>
          ) : (
            <div className="flex min-w-[220px] flex-1 items-center gap-2">
              <div className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl border border-edge-soft/55 bg-elevated px-3.5">
                <Search size={15} strokeWidth={2} className="shrink-0 text-ink-subtle" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    if (e.target.value && mode === "home") setMode("grid");
                  }}
                  placeholder={t("Search {n} channels", { n: playlist?.channels.length ?? 0 })}
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-subtle focus:outline-none"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    className="shrink-0 text-[12.5px] font-medium text-ink-subtle transition-colors hover:text-ink"
                  >
                    {t("Clear")}
                  </button>
                )}
              </div>
              {PHONE && hasCategories && (
                <button
                  type="button"
                  onClick={() => setCatsOpen(true)}
                  aria-label={t("Categories")}
                  className={`flex h-11 shrink-0 items-center gap-1.5 rounded-xl border bg-elevated px-3 text-[13px] font-medium transition-colors active:bg-raised ${
                    group === null ? "border-edge-soft/55 text-ink-muted" : "border-accent/60 text-ink"
                  }`}
                >
                  <ListFilter size={15} strokeWidth={2} className="shrink-0" />
                  <span dir="auto" className="max-w-[92px] truncate">{catsLabel}</span>
                </button>
              )}
            </div>
          )}
          <ViewModeToggle mode={mode} onChange={setMode} />
        </header>
        )}
        {epgError && !epg && (
          <div className="mx-6 mt-2 flex items-center gap-2 rounded-xl border border-danger/40 bg-danger/10 px-4 py-2 text-[12.5px] text-ink-muted">
            <span className="font-semibold text-danger">{t("EPG failed:")}</span>
            <span className="min-w-0 flex-1 truncate">{epgError}</span>
          </div>
        )}
        {mode === "multiview" ? (
          <div className="flex min-h-0 flex-1 flex-col pt-2">
            <MultiviewView
              channels={mvChannels}
              epg={epg}
              active={active}
              sources={allSources}
              playlists={allPlaylists}
              loading={allSources.length > 0 && allPlaylists.size < allSources.length}
            />
          </div>
        ) : (
        <div ref={scrollRef} className={`flex-1 overflow-y-auto pt-5 ${PHONE ? "px-4" : "px-6"}`}>
          {state.kind === "error" ? (
            <ErrorBlock
              message={state.message}
              onRetry={() => {
                if (activeId) clearPlaylistCache(activeId);
                refresh();
              }}
              onEdit={activeId ? () => setEditRequest({ id: activeId, nonce: Date.now() }) : undefined}
              onRemove={
                activeId
                  ? async () => {
                      const name = managedSources.find((s) => s.id === activeId)?.name ?? "";
                      if (await confirmDialog(t('Remove playlist "{name}"?', { name }))) removePlaylist(activeId);
                    }
                  : undefined
              }
            />
          ) : state.kind === "loading" ? (
            mode === "guide" ? <GuideSkeleton /> : <GridSkeleton />
          ) : (
            <>
              {mode === "home" && playlist && (
                <LiveHome
                  channels={shownChannels}
                  epg={epg}
                  nowMs={nowMs}
                  sourceId={activeId ?? ""}
                  region={region}
                  favorites={favorites}
                  onPlay={handlePlay}
                  onOpenCategory={(g) => {
                    setGroup(g);
                    setMode("grid");
                  }}
                />
              )}
              {mode !== "home" && playlist && visible.length === 0 && (
                <EmptyResult onClear={() => { setQuery(""); setGroup(null); }} />
              )}
              {visible.length > 0 && mode === "grid" && (
                <div className="flex flex-col gap-6">
                  {showTopRows && (
                    <TopNetworksRows rows={topRows} channels={regionChannels} onPlay={handlePlay} />
                  )}
                  <ChannelGrid
                    channels={visible}
                    onPlay={handlePlay}
                    onInfo={(meta) => openMeta(meta, { liveContext: true })}
                    epg={epg}
                    nowMs={nowMs}
                    resetKey={`${activeId}|${group ?? ""}|${listQuery}`}
                  />
                </div>
              )}
              {visible.length > 0 && mode === "guide" && (
                <GuideView
                  channels={visible}
                  epg={epg}
                  nowMs={nowMs}
                  onPlay={handlePlay}
                  onPlayCatchup={handlePlayCatchup}
                  resetKey={`${activeId}|${group ?? ""}|${listQuery}`}
                />
              )}
            </>
          )}
        </div>
        )}
      </div>
    </main>
  );
}
