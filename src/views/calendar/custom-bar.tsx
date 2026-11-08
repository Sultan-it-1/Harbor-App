import { Film, Globe2, Loader2, Plus, Search, Sparkles, Trash2, Tv2, User, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MOVIE_GENRES, TV_GENRES } from "@/lib/feed/tags";
import { searchAll, type SearchPerson } from "@/lib/search";
import type { Settings } from "@/lib/settings";
import { useT } from "@/lib/i18n";
import traktLogo from "@/assets/trakt.svg";

const WATCH_PROVIDERS: Array<{ id: number; name: string }> = [
  { id: 8, name: "Netflix" },
  { id: 9, name: "Prime Video" },
  { id: 337, name: "Disney+" },
  { id: 384, name: "Max" },
  { id: 15, name: "Hulu" },
  { id: 350, name: "Apple TV+" },
  { id: 531, name: "Paramount+" },
  { id: 386, name: "Peacock" },
  { id: 257, name: "FuboTV" },
  { id: 283, name: "Crunchyroll" },
];

const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" },
  { code: "CN", name: "China" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Germany" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "IN", name: "India" },
  { code: "MX", name: "Mexico" },
  { code: "BR", name: "Brazil" },
];

type CustomCalendar = Settings["customCalendar"];

export function CustomCalendarBar({
  tmdbKey,
  traktConnected,
  value,
  onChange,
}: {
  tmdbKey: string;
  traktConnected: boolean;
  value: CustomCalendar;
  onChange: (next: CustomCalendar) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const addPerson = (p: SearchPerson) => {
    if (value.trackedPeople.some((x) => x.id === p.id)) return;
    onChange({
      ...value,
      trackedPeople: [
        ...value.trackedPeople,
        { id: p.id, name: p.name, profile: p.profile, role: "any" },
      ],
    });
  };
  const removePerson = (id: number) => {
    onChange({ ...value, trackedPeople: value.trackedPeople.filter((p) => p.id !== id) });
  };
  const toggleSource = (k: "includeTraktWatchlist" | "includeTraktAnticipated") => {
    onChange({ ...value, [k]: !value[k] });
  };
  const toggleMediaType = (kind: "movie" | "tv" | "anime") => {
    onChange({ ...value, mediaTypes: { ...value.mediaTypes, [kind]: !value.mediaTypes[kind] } });
  };
  const toggleGenre = (genre: { id: number; name: string; mediaType: "movie" | "tv" }) => {
    const exists = value.genres.some((g) => g.id === genre.id && g.mediaType === genre.mediaType);
    onChange({
      ...value,
      genres: exists
        ? value.genres.filter((g) => !(g.id === genre.id && g.mediaType === genre.mediaType))
        : [...value.genres, genre],
    });
  };
  const toggleProvider = (provider: { id: number; name: string }) => {
    const exists = value.watchProviders.some((p) => p.id === provider.id);
    onChange({
      ...value,
      watchProviders: exists
        ? value.watchProviders.filter((p) => p.id !== provider.id)
        : [...value.watchProviders, provider],
    });
  };
  const toggleCountry = (code: string) => {
    const exists = value.originCountries.includes(code);
    onChange({
      ...value,
      originCountries: exists
        ? value.originCountries.filter((c) => c !== code)
        : [...value.originCountries, code],
    });
  };

  const summary = (() => {
    const bits: string[] = [];
    if (value.trackedPeople.length)
      bits.push(t("{n} people", { n: value.trackedPeople.length }));
    if (value.genres.length)
      bits.push(
        value.genres.length === 1
          ? t("{n} genre", { n: value.genres.length })
          : t("{n} genres", { n: value.genres.length }),
      );
    if (value.watchProviders.length)
      bits.push(
        value.watchProviders.length === 1
          ? t("{n} provider", { n: value.watchProviders.length })
          : t("{n} providers", { n: value.watchProviders.length }),
      );
    if (value.originCountries.length)
      bits.push(
        value.originCountries.length === 1
          ? t("{n} country", { n: value.originCountries.length })
          : t("{n} countries", { n: value.originCountries.length }),
      );
    if (value.includeTraktAnticipated) bits.push(t("Anticipated"));
    if (value.includeTraktWatchlist) bits.push(t("Watchlist"));
    if (bits.length === 0) return t("Empty — click to add filters");
    return bits.join(" · ");
  })();

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-full border border-edge-soft bg-elevated/40 px-4 py-1.5 text-[12.5px] font-medium text-ink-muted transition-colors hover:border-edge hover:text-ink"
      >
        <UserPlus size={13} strokeWidth={2.2} />
        <span className="text-ink">{t("Manage")}</span>
        <span className="text-ink-subtle">·</span>
        <span className="truncate max-w-[260px]">{summary}</span>
      </button>
      {open &&
        createPortal(
          <CustomManager
            tmdbKey={tmdbKey}
            traktConnected={traktConnected}
            value={value}
            onAddPerson={addPerson}
            onRemovePerson={removePerson}
            onToggleSource={toggleSource}
            onToggleMediaType={toggleMediaType}
            onToggleGenre={toggleGenre}
            onToggleProvider={toggleProvider}
            onToggleCountry={toggleCountry}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}

function CustomManager({
  tmdbKey,
  traktConnected,
  value,
  onAddPerson,
  onRemovePerson,
  onToggleSource,
  onToggleMediaType,
  onToggleGenre,
  onToggleProvider,
  onToggleCountry,
  onClose,
}: {
  tmdbKey: string;
  traktConnected: boolean;
  value: CustomCalendar;
  onAddPerson: (p: SearchPerson) => void;
  onRemovePerson: (id: number) => void;
  onToggleSource: (k: "includeTraktWatchlist" | "includeTraktAnticipated") => void;
  onToggleMediaType: (kind: "movie" | "tv" | "anime") => void;
  onToggleGenre: (g: { id: number; name: string; mediaType: "movie" | "tv" }) => void;
  onToggleProvider: (p: { id: number; name: string }) => void;
  onToggleCountry: (code: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchPerson[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q || !tmdbKey) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const handle = window.setTimeout(async () => {
      try {
        const r = await searchAll(tmdbKey, q);
        if (!cancelled) setResults(r.people.slice(0, 8));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query, tmdbKey]);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-canvas/85 p-6 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-[720px] flex-col overflow-hidden rounded-2xl border border-edge-soft bg-elevated shadow-[0_30px_80px_-20px_rgba(0,0,0,0.7)]">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-edge-soft px-7 py-5">
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-[22px] font-medium leading-none tracking-tight text-ink">
              {t("Custom calendar")}
            </h2>
            <p className="text-[13px] text-ink-muted">
              {t(
                "Pick what you want in your calendar. Mix and match: tracked people, genres, streamers, countries, Trakt lists.",
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-subtle transition-colors hover:bg-canvas/70 hover:text-ink"
          >
            <X size={15} strokeWidth={2.2} />
          </button>
        </header>
        <div className="flex flex-col gap-6 overflow-y-auto px-7 py-6">

      <Section title={t("What to include")}>
        <div className="flex flex-wrap gap-2">
          <PillToggle
            on={value.mediaTypes.movie}
            onClick={() => onToggleMediaType("movie")}
            icon={<Film size={12} strokeWidth={2.2} />}
            label={t("Movies")}
          />
          <PillToggle
            on={value.mediaTypes.tv}
            onClick={() => onToggleMediaType("tv")}
            icon={<Tv2 size={12} strokeWidth={2.2} />}
            label={t("Series")}
          />
          <PillToggle
            on={value.mediaTypes.anime}
            onClick={() => onToggleMediaType("anime")}
            icon={<Sparkles size={12} strokeWidth={2.2} />}
            label={t("Anime")}
          />
        </div>
      </Section>

      <Section title={t("Genres")}>
        <ChipMultiselect
          items={[
            ...Object.entries(MOVIE_GENRES).map(([name, id]) => ({
              key: `movie:${id}`,
              label: t(name),
              selected: value.genres.some((g) => g.id === id && g.mediaType === "movie"),
              onToggle: () => onToggleGenre({ id, name, mediaType: "movie" }),
            })),
            ...Object.entries(TV_GENRES)
              .filter(([name]) => !(name in MOVIE_GENRES))
              .map(([name, id]) => ({
                key: `tv:${id}`,
                label: t("{name} (TV)", { name: t(name) }),
                selected: value.genres.some((g) => g.id === id && g.mediaType === "tv"),
                onToggle: () => onToggleGenre({ id, name, mediaType: "tv" }),
              })),
          ]}
        />
      </Section>

      <Section title={t("Where to watch")}>
        <ChipMultiselect
          items={WATCH_PROVIDERS.map((p) => ({
            key: `prov:${p.id}`,
            label: p.name,
            selected: value.watchProviders.some((x) => x.id === p.id),
            onToggle: () => onToggleProvider(p),
          }))}
        />
      </Section>

      <Section title={t("Origin country")} icon={<Globe2 size={11} strokeWidth={2.2} />}>
        <ChipMultiselect
          items={COUNTRIES.map((c) => ({
            key: `cn:${c.code}`,
            label: t(c.name),
            selected: value.originCountries.includes(c.code),
            onToggle: () => onToggleCountry(c.code),
          }))}
        />
      </Section>

      <Section title={t("Trakt sources")}>
        <ToggleRow
          label={t("Trakt anticipated")}
          sub={t("Most-anticipated upcoming releases on Trakt")}
          on={value.includeTraktAnticipated}
          onToggle={() => onToggleSource("includeTraktAnticipated")}
          icon={<img src={traktLogo} alt="" className="h-3.5 w-3.5" />}
        />
        <ToggleRow
          label={t("My Trakt watchlist")}
          sub={
            traktConnected
              ? t("Upcoming items from your watchlist")
              : t("Connect Trakt in settings first")
          }
          on={value.includeTraktWatchlist}
          onToggle={() => traktConnected && onToggleSource("includeTraktWatchlist")}
          disabled={!traktConnected}
          icon={<img src={traktLogo} alt="" className="h-3.5 w-3.5" />}
        />
      </Section>

      <Section title={t("Track people ({n})", { n: value.trackedPeople.length })}>
        <div className="flex h-10 items-center gap-2 rounded-xl border border-edge bg-canvas px-3">
          <Search size={13} className="text-ink-subtle" strokeWidth={2} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              tmdbKey ? t("Search actors, directors…") : t("Add a TMDB key in settings first")
            }
            disabled={!tmdbKey}
            className="h-full flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-subtle outline-none"
          />
          {busy && <Loader2 size={13} className="animate-spin text-ink-subtle" />}
        </div>
        {results.length > 0 && (
          <div className="max-h-[180px] overflow-y-auto rounded-xl border border-edge-soft bg-canvas/60">
            {results.map((p) => {
              const tracked = value.trackedPeople.some((x) => x.id === p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={tracked}
                  onClick={() => {
                    onAddPerson(p);
                    setQuery("");
                    setResults([]);
                  }}
                  className="flex w-full items-center gap-2.5 border-b border-edge-soft/50 px-3 py-2 text-start text-[12.5px] last:border-b-0 hover:bg-elevated disabled:opacity-50"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-elevated text-ink-subtle">
                    {p.profile ? (
                      <img
                        src={`https://image.tmdb.org/t/p/w92${p.profile}`}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <User size={14} strokeWidth={1.8} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">{p.name}</span>
                    <span className="block truncate text-[11px] text-ink-subtle">{p.knownFor}</span>
                  </span>
                  {tracked ? (
                    <span className="text-[10.5px] uppercase tracking-[0.14em] text-ink-subtle">{t("added")}</span>
                  ) : (
                    <Plus size={13} className="text-ink-subtle" />
                  )}
                </button>
              );
            })}
          </div>
        )}
        {value.trackedPeople.length > 0 && (
          <ul className="flex flex-col gap-1">
            {value.trackedPeople.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-2.5 rounded-lg bg-canvas/40 px-2.5 py-1.5"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-elevated text-ink-subtle">
                  {p.profile ? (
                    <img
                      src={`https://image.tmdb.org/t/p/w92${p.profile}`}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <User size={12} strokeWidth={1.8} />
                  )}
                </span>
                <span className="flex-1 truncate text-[12.5px] text-ink">{p.name}</span>
                <button
                  type="button"
                  onClick={() => onRemovePerson(p.id)}
                  aria-label={t("Remove {name}", { name: p.name })}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-ink-subtle transition-colors hover:bg-danger/15 hover:text-danger"
                >
                  <Trash2 size={12} strokeWidth={1.9} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-ink-subtle">
        {icon}
        {title}
      </div>
      {children}
    </section>
  );
}

function PillToggle({
  on,
  onClick,
  icon,
  label,
}: {
  on: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[12.5px] font-semibold transition-colors ${
        on
          ? "border-ink bg-ink text-canvas"
          : "border-edge-soft bg-canvas/40 text-ink-muted hover:border-edge hover:text-ink"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function ChipMultiselect({
  items,
}: {
  items: Array<{ key: string; label: string; selected: boolean; onToggle: () => void }>;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={item.onToggle}
          className={`h-7 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors ${
            item.selected
              ? "border-accent/55 bg-accent/15 text-accent"
              : "border-edge-soft/70 bg-canvas/40 text-ink-muted hover:border-edge hover:text-ink"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({
  label,
  sub,
  on,
  onToggle,
  disabled,
  icon,
}: {
  label: string;
  sub?: string;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-start transition-colors ${
        disabled
          ? "cursor-not-allowed border-edge-soft/40 opacity-60"
          : "border-edge-soft hover:border-edge"
      }`}
    >
      {icon && <span className="text-ink-muted">{icon}</span>}
      <span className="flex flex-1 flex-col">
        <span className="text-[12.5px] font-semibold text-ink">{label}</span>
        {sub && <span className="text-[11px] text-ink-subtle">{sub}</span>}
      </span>
      <span
        aria-hidden
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-ink" : "bg-edge"}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-canvas transition-transform ${
            on ? "translate-x-[18px] rtl:-translate-x-[18px]" : "translate-x-0.5 rtl:-translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}
