import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackToTop } from "@/components/back-to-top";
import { selectSpotlights } from "@/lib/feed/genre-spotlights";
import { SeenIdsProvider } from "@/lib/feed/seen-ids";
import { useScrollMemory, useView, type MetaFilter } from "@/lib/view";
import { useT } from "@/lib/i18n";
import { useSettings } from "@/lib/settings";
import { MOVIE_GENRES } from "@/lib/feed/tags";
import { useNativeBrowsePage, useNativeScreensEnabled } from "@/views/native/native-screens";
import { NativeRowSinkContext, useNativeRowSink } from "@/views/native/native-sink";
import { describe, filterIconName, Header } from "./filter/header";
import { Rails } from "./filter/rails";
import {
  SPOTLIGHT_TIMEOUT_MS,
  SpotlightGateContext,
  type SpotlightGate,
} from "./filter/spotlight-gate";

export function FilterView({ filter }: { filter: MetaFilter }) {
  const scrollRef = useRef<HTMLElement>(null);
  const seenRef = useRef(new Map<string, string>());
  const expectedSpotlights = useMemo(
    () => (filter.kind === "genre" ? selectSpotlights(filter.name).length : 0),
    [filter],
  );
  const [doneSpotlights, setDoneSpotlights] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    seenRef.current = new Map();
    setDoneSpotlights(0);
    setTimedOut(false);
    const t = window.setTimeout(() => setTimedOut(true), SPOTLIGHT_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [filter]);
  const markDone = useCallback(() => setDoneSpotlights((n) => n + 1), []);
  const ready = expectedSpotlights === 0 || doneSpotlights >= expectedSpotlights || timedOut;
  const gate = useMemo<SpotlightGate>(() => ({ ready, markDone }), [ready, markDone]);
  useScrollMemory(filterKey(filter), scrollRef);

  // Android: drawn natively (see @/views/native/native-screens) like the page: the kicker with its
  // icon, the big title (a genre's opens the other genres), the line under it, then the rails,
  // which load themselves and hand their rows over (native-sink).
  const t = useT();
  const { topKind, openFilter } = useView();
  const { settings } = useSettings();
  const nativeOn = useNativeScreensEnabled();
  const [sink, nativeRows] = useNativeRowSink(nativeOn);
  const nativeHeader = useMemo(() => {
    const d = describe(filter, t);
    const genre = filter.kind === "genre";
    return {
      icon: filterIconName(filter),
      kicker: d.kicker,
      title: genre ? t(d.title) : d.title,
      subtitle: d.subtitle,
      size: 44,
      switch: genre ? Object.keys(MOVIE_GENRES).map((name) => ({ id: name, label: t(name), on: name === d.title })) : [],
    };
  }, [filter, t]);
  const nativeChips = useMemo(
    () =>
      filter.kind === "country"
        ? [
            {
              key: "media",
              items: [
                { id: "tv", label: t("Shows"), on: filter.mediaType === "tv" },
                { id: "movie", label: t("Movies"), on: filter.mediaType === "movie" },
              ],
            },
          ]
        : null,
    [filter, t],
  );
  const native = useNativeBrowsePage("filter", {
    scrollKey: JSON.stringify(filter),
    active: topKind === "filter",
    t,
    back: true,
    header: nativeHeader,
    chips: nativeChips,
    onChip: (group, id) => {
      if (group === "switch" && id in MOVIE_GENRES) openFilter({ kind: "genre", mediaType: filter.mediaType, name: id, id: MOVIE_GENRES[id] });
      else if (group === "media" && (id === "tv" || id === "movie") && id !== filter.mediaType) openFilter({ ...filter, mediaType: id });
    },
    rows: nativeRows,
    empty:
      !settings.tmdbKey && filter.kind !== "genre"
        ? { title: t("Add a TMDB key to browse by this filter."), text: t("Year, runtime, language, and country filters need TMDB. Genre browsing falls back to Cinemeta automatically.") }
        : { text: t("Loading…") },
  });
  if (native) {
    return (
      <SeenIdsProvider value={seenRef}>
        <SpotlightGateContext.Provider value={gate}>
          <NativeRowSinkContext.Provider value={sink}>
            <main ref={scrollRef} aria-hidden="true" className="absolute inset-0 z-30 overflow-hidden bg-canvas">
              <Rails filter={filter} />
            </main>
          </NativeRowSinkContext.Provider>
        </SpotlightGateContext.Provider>
      </SeenIdsProvider>
    );
  }
  return (
    <SeenIdsProvider value={seenRef}>
      <SpotlightGateContext.Provider value={gate}>
        <main ref={scrollRef} className="absolute inset-0 z-30 overflow-y-auto bg-canvas">
          <Header filter={filter} />
          <div className="flex flex-col gap-12 px-12 pb-24">
            <Rails filter={filter} />
          </div>
          <BackToTop scrollRef={scrollRef} />
        </main>
      </SpotlightGateContext.Provider>
    </SeenIdsProvider>
  );
}

function filterKey(f: MetaFilter): string {
  if (f.kind === "year" || f.kind === "runtime") {
    return `filter:${f.kind}:${f.mediaType}:${f.value}`;
  }
  return `filter:${f.kind}:${f.mediaType}:${f.name}`;
}
