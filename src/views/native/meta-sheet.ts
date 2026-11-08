// Android: a poster's long-press menu, drawn by the native screen as its menu sliding up from the
// bottom, with the rows the page's own menu (components/context-menu) shows for a title: View
// details, Watchlist, Favorite, My list and, together, Bring friends here.

import type { Meta } from "@/lib/cinemeta";
import { useT } from "@/lib/i18n";
import { useInLocalWatchlist, useLocalWatchlist } from "@/lib/local-watchlist";
import { useIsFavorite, useMediaFavorites } from "@/lib/media-favorites";
import { useTmdbImdbId } from "@/lib/providers/tmdb";
import { useTogether } from "@/lib/together/provider";
import { useView } from "@/lib/view";
import { toggleWatchlist, useInWatchlist } from "@/lib/watchlist";
import type { MenuEntry } from "@/views/detail/overflow-sync-items";

export function useMetaSheetItems(meta: Meta | null): MenuEntry[] {
  const t = useT();
  const { openMeta } = useView();
  const { snapshot, sendSummon } = useTogether();
  const id = meta?.id;
  const imdb = useTmdbImdbId(id);
  const inWatchlist = useInWatchlist(id, [imdb]);
  const { toggle: toggleFavorite } = useMediaFavorites();
  const isFav = useIsFavorite(id);
  const { toggle: toggleLocal } = useLocalWatchlist();
  const isLocal = useInLocalWatchlist(id);
  if (!meta) return [];
  const out: MenuEntry[] = [
    { id: "details", label: t("View details"), icon: "info", onSelect: () => openMeta(meta) },
    {
      id: "watchlist",
      label: inWatchlist ? t("In watchlist") : t("Add to watchlist"),
      icon: inWatchlist ? "bookmark-check" : "bookmark",
      active: inWatchlist,
      onSelect: () => toggleWatchlist({ id: meta.id, type: meta.type, name: meta.name, poster: meta.poster, imdbId: imdb }),
    },
    {
      id: "favorite",
      label: isFav ? t("Favorited") : t("Favorite"),
      icon: "star",
      active: isFav,
      onSelect: () => toggleFavorite({ id: meta.id, type: meta.type, name: meta.name, poster: meta.poster }),
    },
    {
      id: "local",
      label: isLocal ? t("In my list") : t("Add to my list"),
      icon: isLocal ? "list-checks" : "list-plus",
      active: isLocal,
      onSelect: () => toggleLocal({ id: meta.id, type: meta.type, name: meta.name, poster: meta.poster }),
    },
  ];
  if (snapshot.state === "joined") {
    out.push({
      id: "bring",
      label: t("Bring friends here"),
      icon: "users",
      onSelect: () => {
        sendSummon({
          mediaId: meta.id,
          mediaType: meta.type === "series" ? "series" : "movie",
          mediaTitle: meta.name,
          posterUrl: meta.poster,
          backgroundUrl: meta.background,
          releaseInfo: meta.releaseInfo,
        });
        openMeta(meta);
      },
    });
  }
  return out;
}
