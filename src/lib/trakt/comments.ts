import { traktRequest } from "./client";
import { TRAKT_API_BASE } from "./config";
import { getTraktKeys } from "./keys";
import { getSession } from "./session";
import type { TraktTarget, TraktIds } from "./types";

export type TraktComment = {
  id: number;
  comment: string;
  spoiler: boolean;
  review: boolean;
  replies: number;
  likes: number;
  createdAt: string;
  userRating: number | null;
  user: {
    username: string;
    name: string | null;
    avatar: string | null;
    slug: string | null;
  };
};

type RawComment = {
  id: number;
  parent_id: number;
  created_at: string;
  updated_at: string;
  comment: string;
  spoiler: boolean;
  review: boolean;
  replies: number;
  likes: number;
  user_stats?: { rating: number; play_count: number; completed_count: number };
  user: {
    username: string;
    private: boolean;
    name: string | null;
    vip: boolean;
    vip_ep: boolean;
    ids: { slug: string };
    images?: { avatar?: { full?: string } };
  };
};

const traktIdOfTmdb = new Map<string, string>();

/**
 * The id for a Trakt path. Trakt takes an IMDb id, a slug or its own number there, not a TMDB
 * id: a title only known by its TMDB id is looked up first. Empty when there is none.
 */
async function pathId(target: TraktTarget): Promise<string> {
  const ids = target.kind === "episode" ? target.show.ids : target.ids;
  if (ids.imdb) return ids.imdb;
  if (ids.slug) return ids.slug;
  if (ids.trakt) return String(ids.trakt);
  if (!ids.tmdb) return "";
  const type = target.kind === "movie" ? "movie" : "show";
  const key = `${type}:${ids.tmdb}`;
  const known = traktIdOfTmdb.get(key);
  if (known) return known;
  const found = await traktRequest<Array<{ movie?: { ids?: TraktIds }; show?: { ids?: TraktIds } }>>(
    `/search/tmdb/${ids.tmdb}?type=${type}`,
  ).catch(() => []);
  const trakt = found[0]?.[type]?.ids?.trakt;
  if (!trakt) return "";
  traktIdOfTmdb.set(key, String(trakt));
  return String(trakt);
}

export async function commentsPath(target: TraktTarget, sort: string): Promise<string | null> {
  const id = await pathId(target);
  if (!id) return null;
  if (target.kind === "episode") {
    return `/shows/${id}/seasons/${target.season}/episodes/${target.number}/comments/${sort}`;
  }
  if (target.kind === "movie") {
    return `/movies/${id}/comments/${sort}`;
  }
  return `/shows/${id}/comments/${sort}`;
}

function mapComment(raw: RawComment): TraktComment {
  return {
    id: raw.id,
    comment: raw.comment,
    spoiler: raw.spoiler,
    review: raw.review,
    replies: raw.replies,
    likes: raw.likes,
    createdAt: raw.created_at,
    userRating: raw.user_stats?.rating ?? null,
    user: {
      username: raw.user.username,
      name: raw.user.name,
      avatar: raw.user.images?.avatar?.full ?? null,
      slug: raw.user.ids.slug,
    },
  };
}

export async function fetchComments(
  target: TraktTarget,
  sort: string = "likes",
  page = 1,
  limit = 20,
): Promise<TraktComment[]> {
  const base = await commentsPath(target, sort);
  if (!base) return [];
  const path = base + `?extended=images&page=${page}&limit=${limit}`;
  const raw = await traktRequest<RawComment[]>(path).catch(() => [] as RawComment[]);
  return raw.map(mapComment);
}

export async function fetchReplies(commentId: number): Promise<TraktComment[]> {
  const raw = await traktRequest<RawComment[]>(`/comments/${commentId}/replies?extended=images`).catch(
    () => [] as RawComment[],
  );
  return raw.map(mapComment);
}

export async function likeComment(id: number): Promise<void> {
  await traktRequest(`/comments/${id}/like`, { method: "POST", authed: true });
}

export async function unlikeComment(id: number): Promise<void> {
  await traktRequest(`/comments/${id}/like`, { method: "DELETE", authed: true });
}

export async function deleteComment(id: number): Promise<void> {
  await traktRequest(`/comments/${id}`, { method: "DELETE", authed: true });
}


/** The ids Trakt can find a title by in a request body. */
function bodyIds(ids: TraktIds): TraktIds | null {
  const out: TraktIds = {};
  if (ids.trakt) out.trakt = ids.trakt;
  if (ids.slug) out.slug = ids.slug;
  if (ids.imdb) out.imdb = ids.imdb;
  if (ids.tmdb) out.tmdb = ids.tmdb;
  return Object.keys(out).length > 0 ? out : null;
}

async function subjectBody(target: TraktTarget) {
  if (target.kind !== "episode") return { [target.kind]: { ids: bodyIds(target.ids) ?? {} } };
  // A comment on an episode needs the episode's own id. The show's ids would put the comment
  // on the wrong item (or nowhere), so the episode is looked up first.
  const show = await pathId(target);
  if (!show) throw new Error("No Trakt ID available for this show");
  const episode = await traktRequest<{ ids?: TraktIds }>(
    `/shows/${show}/seasons/${target.season}/episodes/${target.number}`,
  );
  if (!episode.ids?.trakt) throw new Error("No Trakt ID available for this episode");
  return { episode: { ids: { trakt: episode.ids.trakt } } };
}

export async function postComment(
  target: TraktTarget,
  comment: string,
  spoiler: boolean = false,
): Promise<TraktComment> {
  const body = {
    comment,
    spoiler,
    review: false,
    share: false,
    ...(await subjectBody(target)),
  };
  const raw = await traktRequest<RawComment>("/comments?extended=images", {
    method: "POST",
    authed: true,
    body,
  });
  return mapComment(raw);
}

export async function ratingPath(target: TraktTarget): Promise<string | null> {
  const id = await pathId(target);
  if (!id) return null;
  if (target.kind === "episode") {
    return `/shows/${id}/seasons/${target.season}/episodes/${target.number}/rating`;
  }
  if (target.kind === "movie") return `/movies/${id}/rating`;
  return `/shows/${id}/rating`;
}

/**
 * The body for /sync/ratings (and its /remove, with no rating). Any id Trakt knows works, not
 * only a TMDB one. An episode has no ids of its own here: it is named by its show, season and
 * number.
 */
function ratingsBody(target: TraktTarget, rating?: number): Record<string, unknown> | null {
  const rated = rating == null ? {} : { rating };
  if (target.kind === "episode") {
    const ids = bodyIds(target.show.ids);
    if (!ids) return null;
    return {
      shows: [{ ids, seasons: [{ number: target.season, episodes: [{ number: target.number, ...rated }] }] }],
    };
  }
  const ids = bodyIds(target.ids);
  if (!ids) return null;
  return { [target.kind === "movie" ? "movies" : "shows"]: [{ ...rated, ids }] };
}

export async function rateContent(target: TraktTarget, rating: number): Promise<void> {
  const body = ratingsBody(target, rating);
  if (!body) throw new Error("No ID available for rating");
  await traktRequest("/sync/ratings", { method: "POST", authed: true, body });
}

export async function removeRating(target: TraktTarget): Promise<void> {
  const body = ratingsBody(target);
  if (!body) throw new Error("No ID available for rating");
  await traktRequest("/sync/ratings/remove", { method: "POST", authed: true, body });
}

export async function getUserRating(target: TraktTarget): Promise<number | null> {
  const session = getSession();
  if (!session?.accessToken) return null;

  const epIds = (target as { ids?: TraktIds }).ids;
  const itemId = target.kind === "episode" ? (epIds?.tmdb ?? epIds?.imdb) : (target.ids?.tmdb ?? target.ids?.imdb);
  if (!itemId) return null;

  const param = typeof itemId === "number" ? `tmdb=${itemId}` : `imdb=${itemId}`;
  const type = target.kind === "movie" ? "movies" : target.kind === "episode" ? "episodes" : "shows";

  try {
    const res = await fetch(`${TRAKT_API_BASE}/sync/ratings/${type}?${param}`, {
      headers: {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": getTraktKeys().clientId,
        Authorization: `Bearer ${session.accessToken}`,
      },
      redirect: "manual",
    });
    if (res.status >= 200 && res.status < 300) {
      const data = (await res.json()) as { rating: number }[];
      return data[0]?.rating ?? null;
    }
    return null;
  } catch {
    return null;
  }
}
