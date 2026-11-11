import { useProfiles } from "@/lib/profiles";
import { startTransition, useEffect, useState, type ReactNode } from "react";
import { pushAndroidBackHandler } from "@/lib/android";
import { MoreHorizontal, Search, X , Users } from "lucide-react";
import { AddonsIcon } from "@/components/icons/addons-icon";
import { AnimeIcon } from "@/components/icons/anime-icon";
import { CalendarIcon } from "@/components/icons/calendar-icon";
import { DiscoverIcon } from "@/components/icons/discover-icon";
import { HomeIcon } from "@/components/icons/home-icon";
import { LibraryIcon } from "@/components/icons/library-icon";
import { LiveTvIcon } from "@/components/icons/live-tv-icon";
import { MoviesIcon } from "@/components/icons/movies-icon";
import { PlaylistVodIcon } from "@/components/icons/playlist-vod-icon";
import { SettingsIcon } from "@/components/icons/settings-icon";
import { TvIcon } from "@/components/icons/tv-icon";
import { DownloadsNavIcon } from "@/chrome/downloads-nav-icon";
import { ParentalPinModal } from "@/components/parental-pin-modal";
import { useT } from "@/lib/i18n";
import { useParental, type LockableTab } from "@/lib/parental";
import { useSearch } from "@/lib/search-context";
import { useSettings } from "@/lib/settings";
import { useView, type View } from "@/lib/view";
import { checkAndroidUpdate, useAndroidUpdate } from "@/lib/updater/android-update";

/** Height of the bar above the safe-area inset; content gets this much bottom padding. */
export const PHONE_TABBAR_H = 60;

type Item = {
  view: View;
  label: string;
  icon: (active: boolean) => ReactNode;
  hideKey?: "anime" | "liveTv" | "sports";
  parentalKey?: LockableTab;
};

const MORE: Item[] = [
  { view: "movies", label: "Movies", icon: (a) => <MoviesIcon active={a} />, parentalKey: "movies" },
  { view: "shows", label: "Shows", icon: (a) => <TvIcon active={a} />, parentalKey: "shows" },
  { view: "anime", label: "Anime", icon: (a) => <AnimeIcon active={a} />, hideKey: "anime", parentalKey: "anime" },
  { view: "live", label: "Live TV", icon: (a) => <LiveTvIcon active={a} />, hideKey: "liveTv", parentalKey: "liveTv" },
  { view: "vod", label: "Playlists", icon: (a) => <PlaylistVodIcon active={a} /> },
  { view: "calendar", label: "Calendar", icon: (a) => <CalendarIcon active={a} />, parentalKey: "calendar" },
  { view: "downloads", label: "Downloads", icon: (a) => <DownloadsNavIcon active={a} /> },
  { view: "addons", label: "Addons", icon: (a) => <AddonsIcon active={a} />, parentalKey: "addons" },
  { view: "settings", label: "Settings", icon: (a) => <SettingsIcon active={a} /> },
];

/** Phone navigation: a native-style bottom tab bar instead of the desktop sidebar. */
export function PhoneTabBar() {
  const { view, setView } = useView();
  const { setOpen: setSearchOpen, open: searchOpen } = useSearch();
  const { locked, unlock, hiddenTabs } = useParental();
  const { settings } = useSettings();
  const t = useT();
  const [moreOpen, setMoreOpen] = useState(false);
  // A new version of the app: a dot on More and on Settings (the update is on the Settings page).
  const update = useAndroidUpdate();
  const updateWaiting = update.status === "available";
  useEffect(() => {
    const id = window.setTimeout(() => void checkAndroidUpdate(false), 8000);
    return () => window.clearTimeout(id);
  }, []);
  const { openPicker: openProfiles, activeProfile } = useProfiles();
  const [pinFor, setPinFor] = useState<View | null>(null);
  // Highlight the tapped tab immediately; the (heavy) view switch renders in a transition,
  // so a tap never looks ignored and nobody needs to tap twice.
  const [pending, setPending] = useState<View | null>(null);
  useEffect(() => {
    if (pending && pending === view) setPending(null);
  }, [pending, view]);
  const shown = pending ?? view;

  // The keyboard pushes the page up and the bar would sit right on top of it, covering the
  // field being typed in: hide the bar while the keyboard is open (the shell reports it).
  const [keyboardUp, setKeyboardUp] = useState(false);
  useEffect(() => {
    const onIme = (e: Event) => setKeyboardUp(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener("harbor:ime", onIme);
    return () => window.removeEventListener("harbor:ime", onIme);
  }, []);

  // Back gesture closes the search / More sheet before leaving the screen.
  useEffect(() => {
    if (!searchOpen && !moreOpen) return;
    return pushAndroidBackHandler(() => {
      setMoreOpen(false);
      setSearchOpen(false);
      return true;
    });
  }, [searchOpen, moreOpen, setSearchOpen]);

  const allowed = (it: Item) => {
    if (it.view === "vod" && !settings.showPlaylistsTab) return false;
    if (it.hideKey && settings.hideContent[it.hideKey]) return false;
    return true;
  };
  const go = (it: Item) => {
    setMoreOpen(false);
    setSearchOpen(false);
    if (it.parentalKey && locked && hiddenTabs[it.parentalKey]) {
      setPinFor(it.view);
      return;
    }
    setPending(it.view);
    startTransition(() => setView(it.view));
  };

  const moreItems = MORE.filter(allowed);
  const moreActive = !searchOpen && moreItems.some((it) => it.view === shown);

  return (
    <>
      {moreOpen && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-[180] flex flex-col justify-end bg-black/55" onClick={() => setMoreOpen(false)}>
          <div
            className="rounded-t-3xl border-t border-edge bg-surface px-4 pt-3"
            style={{ paddingBottom: `calc(${PHONE_TABBAR_H + 12}px + env(safe-area-inset-bottom))` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-subtle/50" />
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-[15px] font-semibold text-ink">{t("More")}</span>
              <button
                aria-label={t("Close")}
                onClick={() => setMoreOpen(false)}
                className="grid h-8 w-8 place-items-center rounded-full text-ink-muted active:bg-elevated"
              >
                <X size={18} />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {moreItems.map((it) => {
                const active = shown === it.view;
                return (
                  <button
                    key={it.view}
                    onClick={() => go(it)}
                    className={`flex flex-col items-center gap-1.5 rounded-2xl px-2 py-3 text-[12px] font-medium transition-colors active:scale-[0.97] ${
                      active ? "bg-accent-soft text-ink" : "bg-elevated/60 text-ink-muted"
                    }`}
                  >
                    <span className="relative grid h-7 w-7 place-items-center">
                      {it.icon(active)}
                      {it.view === "settings" && updateWaiting && (
                        <span className="absolute -end-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-canvas" />
                      )}
                    </span>
                    {t(it.label)}
                  </button>
                );
              })}
            </div>
            {/* Profiles: on the phone the desktop profile chip doesn't exist, so switching,
                adding and editing profiles lives here. */}
            <button
              type="button"
              onClick={() => {
                setMoreOpen(false);
                openProfiles();
              }}
              className="mt-2 flex w-full items-center gap-3 rounded-2xl bg-elevated/60 px-4 py-3 text-start text-[13px] font-medium text-ink-muted active:scale-[0.99]"
            >
              <Users size={18} strokeWidth={2} className="shrink-0" />
              <span className="flex-1">{t("Profiles")}</span>
              {activeProfile && <span className="truncate text-[12px] text-ink-subtle">{activeProfile.name}</span>}
            </button>
          </div>
        </div>
      )}

      {/* Solid, no backdrop blur: the bar never leaves the screen and a blur behind it is
          redrawn on every scrolled frame. */}
      <nav
        data-phone-tabbar
        hidden={keyboardUp}
        className="fixed inset-x-0 bottom-0 z-[190] border-t border-edge-soft bg-canvas/[0.98]"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto flex max-w-xl items-stretch justify-around" style={{ height: PHONE_TABBAR_H }}>
          <Tab label={t("Home")} active={!searchOpen && !moreOpen && shown === "home"} onClick={() => go({ view: "home", label: "Home", icon: () => null })}>
            {(a) => <HomeIcon active={a} />}
          </Tab>
          <Tab
            label={t("Discover")}
            active={!searchOpen && !moreOpen && shown === "discover"}
            onClick={() => go({ view: "discover", label: "Discover", icon: () => null, parentalKey: "discover" })}
          >
            {(a) => <DiscoverIcon active={a} />}
          </Tab>
          <Tab
            label={t("Search")}
            active={searchOpen}
            onClick={() => {
              setMoreOpen(false);
              setSearchOpen(true);
            }}
          >
            {(a) => <Search size={22} strokeWidth={a ? 2.4 : 1.8} />}
          </Tab>
          <Tab
            label={t("Library")}
            active={!searchOpen && !moreOpen && shown === "library"}
            onClick={() => go({ view: "library", label: "Library", icon: () => null, parentalKey: "library" })}
          >
            {(a) => <LibraryIcon active={a} />}
          </Tab>
          <Tab
            label={t("More")}
            active={moreOpen || moreActive}
            onClick={() => {
              // From Search the sheet has to open at once: it used to open underneath the search
              // page (which sits above it), so More looked dead while Search was showing.
              setMoreOpen(searchOpen ? true : !moreOpen);
              setSearchOpen(false);
            }}
          >
            {(a) => (
              <span className="relative">
                <MoreHorizontal size={22} strokeWidth={a ? 2.4 : 1.8} />
                {updateWaiting && <span className="absolute -end-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-canvas" />}
              </span>
            )}
          </Tab>
        </div>
      </nav>

      {pinFor !== null && (
        <ParentalPinModal
          mode={{
            kind: "unlock",
            onUnlock: () => {
              const v = pinFor;
              setPinFor(null);
              if (v) setView(v);
            },
            onCancel: () => setPinFor(null),
          }}
          verify={unlock}
        />
      )}
    </>
  );
}

function Tab(props: { label: string; active: boolean; onClick: () => void; children: (active: boolean) => ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      aria-current={props.active ? "page" : undefined}
      className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-[11.5px] font-medium transition-colors active:scale-95 ${
        props.active ? "text-accent" : "text-ink-muted"
      }`}
    >
      <span className="grid h-7 w-7 place-items-center">{props.children(props.active)}</span>
      <span className="leading-none">{props.label}</span>
    </button>
  );
}
