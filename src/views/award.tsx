import { LayoutGrid, List } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackToTop } from "@/components/back-to-top";
import { laurelColorFor } from "@/components/icons/award-logo";
import { AWARD_CATALOG } from "@/lib/awards-catalog";
import {
  awardFilmTotal,
  EMPTY_PEOPLE,
  loadAwardFilms,
  loadAwardPeople,
  type AwardPeople,
} from "@/lib/awards/award-page";
import type { Meta } from "@/lib/cinemeta";
import type { AwardType } from "@/lib/providers/wikidata";
import { useSettings } from "@/lib/settings";
import { useScrollMemory, useView } from "@/lib/view";
import { useT } from "@/lib/i18n";
import { useNativeBrowsePage, useNativeSheet, type NativeRowInput } from "@/views/native/native-screens";
import { AwardHero } from "./award/award-hero";
import { AwardList, openAwardWork, prefersTv, useAwardList } from "./award/award-list";
import { tmdbPersonIdByName } from "@/lib/providers/tmdb";
import { FilmGrid } from "./award/film-grid";
import { PeopleRail } from "./award/people-rail";

const PREVIEW = 18;
const PAGE = 24;
const MODE_KEY = "harbor.award.viewmode";
type AwardMode = "gallery" | "list";

function readMode(): AwardMode {
  try {
    return localStorage.getItem(MODE_KEY) === "list" ? "list" : "gallery";
  } catch {
    return "gallery";
  }
}

export function AwardView({ awardType }: { awardType: AwardType }) {
  const t = useT();
  const meta = AWARD_CATALOG[awardType];
  const { settings } = useSettings();
  const scrollRef = useRef<HTMLElement>(null);

  const [mode, setMode] = useState<AwardMode>(readMode);
  const [films, setFilms] = useState<Meta[]>([]);
  const [filmsDone, setFilmsDone] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [loadingFilms, setLoadingFilms] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [people, setPeople] = useState<AwardPeople>(EMPTY_PEOPLE);
  const [loadingPeople, setLoadingPeople] = useState(true);
  const targetRef = useRef(PREVIEW);

  useScrollMemory(`award:${awardType}`, scrollRef);

  const selectMode = useCallback((m: AwardMode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFilms([]);
    setFilmsDone(false);
    setExpanded(false);
    setLoadingFilms(true);
    setLoadingMore(false);
    setPeople(EMPTY_PEOPLE);
    setLoadingPeople(true);
    targetRef.current = PREVIEW;
    loadAwardFilms(settings.tmdbKey, awardType, PREVIEW)
      .then(({ films, done }) => {
        if (cancelled) return;
        setFilms(films);
        setFilmsDone(done);
        setLoadingFilms(false);
      })
      .catch(() => {
        if (!cancelled) setLoadingFilms(false);
      });
    loadAwardPeople(settings.tmdbKey, awardType)
      .then((p) => {
        if (cancelled) return;
        setPeople(p);
        setLoadingPeople(false);
      })
      .catch(() => {
        if (!cancelled) setLoadingPeople(false);
      });
    return () => {
      cancelled = true;
    };
  }, [awardType, settings.tmdbKey]);

  const loadMore = useCallback(() => {
    if (loadingMore || loadingFilms || filmsDone || !settings.tmdbKey) return;
    setLoadingMore(true);
    targetRef.current += PAGE;
    loadAwardFilms(settings.tmdbKey, awardType, targetRef.current)
      .then(({ films, done }) => {
        setFilms(films);
        setFilmsDone(done);
        setLoadingMore(false);
      })
      .catch(() => setLoadingMore(false));
  }, [awardType, settings.tmdbKey, loadingMore, loadingFilms, filmsDone]);

  const onViewAll = useCallback(() => {
    setExpanded(true);
    loadMore();
  }, [loadMore]);

  const tint = laurelColorFor(awardType) ?? "#E8AA6C";
  const hasKey = !!settings.tmdbKey;
  const isEmpty =
    !loadingFilms &&
    !loadingPeople &&
    films.length === 0 &&
    people.actors.length === 0 &&
    people.directors.length === 0 &&
    people.writers.length === 0;

  // Android: the gallery drawn natively (see @/views/native/native-screens) like the page: the
  // award's name over its winners' pictures, founded / years, what it is, Gallery / List, the
  // winning films (a grid; "View all" then more as it scrolls) and its actors, directors and
  // writers (a "3×" pill on those who won more than once). The list stays the page's own.
  const { topKind, openPerson } = useView();
  const filmsTotal = awardFilmTotal(awardType);
  const nativeHeader = useMemo(() => {
    const pics: string[] = [];
    for (const f of films) {
      const u = f.background ?? f.poster;
      if (u && !pics.includes(u)) pics.push(u);
      if (pics.length >= 4) break;
    }
    return {
      kicker: meta.shorthand,
      title: meta.title,
      size: 40,
      tint,
      subtitle:
        meta.founded > 0
          ? `${t("Founded {year}", { year: meta.founded })}  ·  ${t("{n} years", { n: new Date().getFullYear() - meta.founded })}`
          : null,
      backdrop: pics,
      body: [meta.description, meta.tagline].filter(Boolean).join("\n\n") || null,
      bodyLines: 6,
    };
  }, [films, meta, tint, t]);
  // The List: the page's winners by category (decades and a search over them), each winner's year
  // in the award's colour, the work, who won it; a tap opens the work, a long-press lists who
  // won it (a tap on a name opens the person).
  const list = useAwardList(awardType);
  const { openMeta } = useView();
  const [recipients, setRecipients] = useState<string[] | null>(null);
  useNativeSheet(
    recipients && recipients.length > 0 ? `recipients:${recipients.join("|")}` : null,
    (recipients ?? []).map((name, i) => ({
      id: `r:${i}`,
      label: name,
      icon: "users",
      onSelect: () => {
        void tmdbPersonIdByName(settings.tmdbKey, name).then((id) => {
          if (id) openPerson(id);
        });
      },
    })),
    () => setRecipients(null),
  );
  const listRows = useMemo<NativeRowInput[]>(
    () =>
      list.filteredHistory.map((group) => ({
        key: `cat:${group.category.key}`,
        title: group.category.name,
        note: group.entries.length === 1 ? t("{n} year", { n: 1 }) : t("{n} years", { n: group.entries.length }),
        kind: "winners" as const,
        metas: [],
        cards: group.entries.map((e) => ({ title: e.workTitle, sub: String(e.year), desc: e.recipients.join(", ") || null, tint })),
        onOpen: (i) => {
          const e = group.entries[i];
          if (e && settings.tmdbKey) void openAwardWork(settings.tmdbKey, e.workTitle, e.year, prefersTv(group.category.name), openMeta);
        },
        onAction: (a, i) => {
          const e = group.entries[i];
          if (a !== "hold" || !e || !settings.tmdbKey || e.recipients.length === 0) return false;
          setRecipients(e.recipients);
          return true;
        },
      })),
    [list.filteredHistory, t, tint, settings.tmdbKey, openMeta],
  );
  const nativeRows = useMemo<NativeRowInput[]>(() => {
    const out: NativeRowInput[] = [
      {
        key: "mode",
        title: "",
        metas: [],
        cards: [],
        chips: {
          key: "mode",
          items: [
            { id: "gallery", label: t("Gallery"), on: mode === "gallery" },
            { id: "list", label: t("List"), on: mode === "list" },
          ],
        },
        onRowChip: (id) => selectMode(id === "list" ? "list" : "gallery"),
      },
    ];
    if (mode === "list") return [...out, ...listRows];
    if (!hasKey) return out;
    if (films.length > 0) {
      out.push({
        key: "filmsHead",
        title: t("Winning films & shows"),
        note: filmsTotal > 0 ? (filmsTotal === 1 ? t("{n} title", { n: filmsTotal }) : t("{n} titles", { n: filmsTotal })) : null,
        metas: [],
        cards: [],
        head: true,
      });
      out.push({
        key: "films",
        title: "",
        metas: expanded ? films : films.slice(0, PREVIEW),
        grid: true,
        min: 96,
        more: expanded && !filmsDone ? loadMore : undefined,
      });
      if (!expanded && filmsTotal > PREVIEW) {
        out.push({
          key: "filmsAll",
          title: "",
          metas: [],
          cards: [],
          tools: [{ id: "all", label: t("View all {n} winners", { n: filmsTotal }) }],
          onTool: onViewAll,
        });
      }
    }
    const rail = (key: string, title: string, list: AwardPeople["actors"]) => {
      if (list.length === 0) return;
      out.push({
        key,
        title,
        kind: "poster",
        metas: [],
        cards: list.map((p) => ({
          title: p.name,
          sub: p.work,
          img: p.photo ? [p.photo] : [],
          kicker: p.wins > 1 ? `${p.wins}×` : null,
          tint,
        })),
        onOpen: (i) => {
          const p = list[i];
          if (p) openPerson(p.id);
        },
      });
    };
    rail("actors", t("Celebrated actors"), people.actors);
    rail("directors", t("Acclaimed directors"), people.directors);
    rail("writers", t("Honored writers"), people.writers);
    return out;
  }, [t, mode, selectMode, hasKey, films, filmsTotal, expanded, filmsDone, loadMore, onViewAll, people, tint, openPerson, listRows]);
  const native = useNativeBrowsePage("award", {
    scrollKey: awardType,
    active: topKind === "award",
    t,
    back: true,
    header: nativeHeader,
    rows: nativeRows,
    search:
      mode === "list" && list.history.length > 0
        ? { key: `award-list:${awardType}`, hint: t("Search by recipient or title…"), text: list.query, onQuery: list.setQuery }
        : null,
    chips:
      mode === "list" && list.decades.length > 0
        ? [
            {
              key: "decade",
              items: [
                { id: "all", label: t("All years"), on: list.decade === null },
                ...list.decades.map((d) => ({ id: String(d), label: `${d}s`, on: list.decade === d })),
              ],
            },
          ]
        : [],
    onChip: (group, id) => {
      if (group === "decade") list.setDecade(id === "all" ? null : Number(id));
    },
    message: mode === "list"
      ? list.history.length === 0
        ? { text: t("No winners are catalogued for this award yet.") }
        : list.noResults
          ? {
              text: t("No winners match these filters."),
              action: t("Clear filters"),
              onAction: () => {
                list.setDecade(null);
                list.setQuery("");
              },
            }
          : null
      : !hasKey
      ? { text: t("Add a TMDB key in Settings to unlock posters and the artists behind this award.") }
      : isEmpty
        ? { text: t("No winners are catalogued for this award yet.") }
        : loadingFilms && films.length === 0
          ? { text: t("Loading…") }
          : null,
  });
  if (native) return <main ref={scrollRef} className="relative h-full overflow-hidden bg-canvas" />;

  return (
    <main ref={scrollRef} className="relative h-full overflow-y-auto bg-canvas">
      <AwardHero type={awardType} tint={tint} films={films} />

      <div className="relative mx-auto flex max-w-[1180px] flex-col gap-12 px-12 pb-32 pt-14">
        <section className="flex max-w-3xl flex-col gap-3">
          <p className="text-[16.5px] leading-[1.65] text-ink-muted">{meta.description}</p>
          {meta.tagline && (
            <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
              {meta.tagline}
            </p>
          )}
        </section>

        <ModeToggle mode={mode} onSelect={selectMode} tint={tint} />

        {mode === "list" ? (
          <AwardList awardType={awardType} tint={tint} />
        ) : !hasKey ? (
          <p className="rounded-2xl border border-edge-soft bg-elevated/30 p-6 text-[14px] leading-relaxed text-ink-muted">
            {t("Add a TMDB key in Settings to unlock posters and the artists behind this award.")}
          </p>
        ) : (
          <div className="flex flex-col gap-16">
            <FilmGrid
              films={films}
              total={awardFilmTotal(awardType)}
              loading={loadingFilms}
              loadingMore={loadingMore}
              expanded={expanded}
              done={filmsDone}
              onViewAll={onViewAll}
              onLoadMore={loadMore}
              scrollRoot={scrollRef}
              tint={tint}
            />
            <PeopleRail title={t("Celebrated actors")} people={people.actors} loading={loadingPeople} tint={tint} />
            <PeopleRail title={t("Acclaimed directors")} people={people.directors} loading={loadingPeople} tint={tint} />
            <PeopleRail title={t("Honored writers")} people={people.writers} loading={loadingPeople} tint={tint} />
            {isEmpty && (
              <p className="rounded-2xl border border-edge-soft bg-elevated/30 p-6 text-[14px] leading-relaxed text-ink-muted">
                {t("No winners are catalogued for this award yet.")}
              </p>
            )}
          </div>
        )}
      </div>
      <BackToTop scrollRef={scrollRef} />
    </main>
  );
}

function ModeToggle({
  mode,
  onSelect,
  tint,
}: {
  mode: AwardMode;
  onSelect: (m: AwardMode) => void;
  tint: string;
}) {
  const t = useT();
  return (
    <div className="flex w-fit items-center gap-1 self-start rounded-full border border-edge-soft bg-elevated/40 p-1">
      <button
        type="button"
        onClick={() => onSelect("gallery")}
        className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${
          mode === "gallery" ? "text-canvas" : "text-ink-muted hover:text-ink"
        }`}
        style={mode === "gallery" ? { backgroundColor: tint } : undefined}
      >
        <LayoutGrid size={15} strokeWidth={2.2} />
        {t("Gallery")}
      </button>
      <button
        type="button"
        onClick={() => onSelect("list")}
        className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${
          mode === "list" ? "text-canvas" : "text-ink-muted hover:text-ink"
        }`}
        style={mode === "list" ? { backgroundColor: tint } : undefined}
      >
        <List size={15} strokeWidth={2.2} />
        {t("Full list")}
      </button>
    </div>
  );
}
