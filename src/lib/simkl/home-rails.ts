import { hydrateTraktItems } from "@/lib/trakt/hydrate";
import type { TraktItem } from "@/lib/trakt/types";
import type { HomeRow } from "@/views/home/home-types";
import { fetchWatchingItems, fetchWatchlist } from "./watchlist";
import type { SimklItem } from "./types";

const PER_RAIL = 24;

function toHydratable(items: SimklItem[]): TraktItem[] {
  return items.map((it) => ({
    type: it.type,
    title: it.title,
    year: it.year,
    ids: {
      imdb: it.ids.imdb,
      tmdb: typeof it.ids.tmdb === "number" ? it.ids.tmdb : undefined,
    },
  }));
}

export async function buildSimklHomeRows(tmdbKey: string): Promise<HomeRow[]> {
  const [plan, watching] = await Promise.all([
    fetchWatchlist().catch(() => []),
    fetchWatchingItems().catch(() => []),
  ]);
  const [planMetas, watchMetas] = await Promise.all([
    hydrateTraktItems(toHydratable(plan).slice(0, PER_RAIL), tmdbKey),
    hydrateTraktItems(toHydratable(watching).slice(0, PER_RAIL), tmdbKey),
  ]);

  const rows: HomeRow[] = [];
  if (watchMetas.length >= 4) {
    rows.push({
      key: "simkl-watching",
      type: watching[0]?.type === "show" ? "series" : "movie",
      name: "Watching on Simkl",
      metas: watchMetas,
      page: 1,
      hasMore: false,
      noDedup: true,
    });
  }
  if (planMetas.length >= 4) {
    rows.push({
      key: "simkl-plantowatch",
      type: plan[0]?.type === "show" ? "series" : "movie",
      name: "Your Simkl Plan to Watch",
      metas: planMetas,
      page: 1,
      hasMore: false,
      noDedup: true,
    });
  }
  return rows;
}
