import { Check, ChevronDown, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import simklLogo from "@/assets/simkl.png";
import { kitsuToMal } from "@/lib/providers/anime-mapping";
import { stremioIdToSimklTarget } from "@/lib/simkl/ids";
import {
  clearSimklStatus,
  loadSimklStatusMap,
  MOVIE_STATUS_ORDER,
  setSimklStatus,
  SHOW_STATUS_ORDER,
  SIMKL_STATUS_LABELS,
  statusForId,
  type WatchlistStatus,
} from "@/lib/simkl/list-status";
import { useSimkl } from "@/lib/simkl/provider";
import type { SimklTarget } from "@/lib/simkl/types";
import traktLogo from "@/assets/trakt.png";
import { useTrakt } from "@/lib/trakt/provider";
import { pushWatched } from "@/lib/trakt/history";
import { useT } from "@/lib/i18n";

function GroupRow({
  logo,
  label,
  open,
  onClick,
}: {
  logo: string;
  label: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex h-9 items-center gap-2.5 rounded-lg px-3 text-start text-[13px] text-ink transition-colors hover:bg-raised"
    >
      <img src={logo} alt="" className="h-[14px] w-[14px] rounded-[3px] object-contain" />
      <span className="flex-1 truncate">{label}</span>
      <ChevronDown
        size={13}
        className={`text-ink-muted transition-transform ${open ? "rotate-180" : ""}`}
      />
    </button>
  );
}

function StatusRow({
  label,
  active,
  danger,
  onClick,
}: {
  label: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex h-8 items-center justify-between gap-2 rounded-lg py-1 ps-9 pe-3 text-start text-[12.5px] transition-colors ${
        danger
          ? "text-ink-muted hover:bg-danger/15 hover:text-danger"
          : active
            ? "text-ink"
            : "text-ink-muted hover:bg-raised hover:text-ink"
      }`}
    >
      <span className="flex items-center gap-2">
        {danger && <Trash2 size={12} />}
        {label}
      </span>
      {active && <Check size={13} className="text-ink" />}
    </button>
  );
}

/** A row of the "…" menu as data (Android's native menu draws these). */
export type MenuEntry = {
  id: string;
  label: string;
  icon?: string;
  active?: boolean;
  danger?: boolean;
  /** Under a group (Simkl's statuses). */
  indent?: boolean;
  /** Opens / closes the rows under it (the menu stays up). */
  group?: boolean;
  open?: boolean;
  divider?: boolean;
  onSelect?: () => void;
};

/** Simkl's rows (Add to Simkl, or its status with the others under it), as data. */
export function useSimklMenu(harborId: string, type: "movie" | "series", onAction: () => void): MenuEntry[] {
  const t = useT();
  const { isConnected } = useSimkl();
  const [target, setTarget] = useState<SimklTarget | null>(null);
  const [status, setStatus] = useState<WatchlistStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isConnected) return;
    let cancelled = false;
    void (async () => {
      let tg: SimklTarget | null = null;
      const r = stremioIdToSimklTarget(harborId);
      if (r.ok) {
        tg = r.target;
      } else if (harborId.startsWith("kitsu:")) {
        const n = Number(harborId.split(":")[1]);
        const mal = Number.isFinite(n) ? await kitsuToMal(n).catch(() => null) : null;
        if (mal != null) tg = { kind: "show", ids: { mal } };
      }
      if (cancelled || !tg) return;
      if (type === "series" && tg.kind === "movie") tg = { kind: "show", ids: tg.ids };
      if (type === "movie" && tg.kind === "show") tg = { kind: "movie", ids: tg.ids };
      setTarget(tg);
      const malKey = tg.kind !== "episode" && tg.ids.mal != null ? `mal:${tg.ids.mal}` : null;
      try {
        const m = await loadSimklStatusMap();
        if (cancelled) return;
        setStatus(statusForId(m, harborId) ?? (malKey ? statusForId(m, malKey) : null));
        setReady(true);
      } catch {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [harborId, isConnected, type]);

  if (!isConnected || !target || !ready) return [];
  if (status == null) {
    return [
      {
        id: "simkl:add",
        label: t("Add to Simkl"),
        icon: "bookmark",
        onSelect: () => {
          void setSimklStatus(target, "plantowatch").catch(() => {});
          onAction();
        },
      },
    ];
  }
  const order = target.kind === "movie" ? MOVIE_STATUS_ORDER : SHOW_STATUS_ORDER;
  const out: MenuEntry[] = [
    { id: "simkl:group", label: `Simkl  ·  ${t(SIMKL_STATUS_LABELS[status])}`, icon: "bookmark", group: true, open, onSelect: () => setOpen((v) => !v) },
  ];
  if (open) {
    for (const st of order) {
      out.push({
        id: `simkl:${st}`,
        label: t(SIMKL_STATUS_LABELS[st]),
        indent: true,
        active: st === status,
        onSelect: () => {
          void setSimklStatus(target, st).catch(() => {});
          onAction();
        },
      });
    }
    out.push({
      id: "simkl:remove",
      label: t("Remove from list"),
      indent: true,
      danger: true,
      onSelect: () => {
        void clearSimklStatus(target).catch(() => {});
        onAction();
      },
    });
  }
  return out;
}

/** Trakt's row (Mark watched on Trakt, films only), as data. */
export function useTraktMenu(harborId: string, type: "movie" | "series", onAction: () => void): MenuEntry[] {
  const t = useT();
  const { isConnected, resolveTarget } = useTrakt();
  if (!isConnected || type !== "movie") return [];
  const target = resolveTarget(harborId);
  if (!target || target.kind !== "movie") return [];
  return [
    {
      id: "trakt:watched",
      label: t("Mark watched on Trakt"),
      icon: "check",
      onSelect: () => {
        void pushWatched(target).catch(() => {});
        onAction();
      },
    },
  ];
}

export function SimklMenuItems({
  harborId,
  type,
  onAction,
}: {
  harborId: string;
  type: "movie" | "series";
  onAction: () => void;
}) {
  const t = useT();
  const { isConnected } = useSimkl();
  const [target, setTarget] = useState<SimklTarget | null>(null);
  const [status, setStatus] = useState<WatchlistStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isConnected) return;
    let cancelled = false;
    void (async () => {
      let t: SimklTarget | null = null;
      const r = stremioIdToSimklTarget(harborId);
      if (r.ok) {
        t = r.target;
      } else if (harborId.startsWith("kitsu:")) {
        const n = Number(harborId.split(":")[1]);
        const mal = Number.isFinite(n) ? await kitsuToMal(n).catch(() => null) : null;
        if (mal != null) t = { kind: "show", ids: { mal } };
      }
      if (cancelled || !t) return;
      if (type === "series" && t.kind === "movie") t = { kind: "show", ids: t.ids };
      if (type === "movie" && t.kind === "show") t = { kind: "movie", ids: t.ids };
      setTarget(t);
      const malKey = t.kind !== "episode" && t.ids.mal != null ? `mal:${t.ids.mal}` : null;
      try {
        const m = await loadSimklStatusMap();
        if (cancelled) return;
        setStatus(statusForId(m, harborId) ?? (malKey ? statusForId(m, malKey) : null));
        setReady(true);
      } catch {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [harborId, isConnected, type]);

  if (!isConnected || !target || !ready) return null;
  const order = target.kind === "movie" ? MOVIE_STATUS_ORDER : SHOW_STATUS_ORDER;

  if (status == null) {
    return (
      <GroupRow
        logo={simklLogo}
        label={t("Add to Simkl")}
        open={false}
        onClick={() => {
          void setSimklStatus(target, "plantowatch").catch(() => {});
          onAction();
        }}
      />
    );
  }
  return (
    <>
      <GroupRow
        logo={simklLogo}
        label={`Simkl  ·  ${t(SIMKL_STATUS_LABELS[status])}`}
        open={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <>
          {order.map((s) => (
            <StatusRow
              key={s}
              label={t(SIMKL_STATUS_LABELS[s])}
              active={s === status}
              onClick={() => {
                void setSimklStatus(target, s).catch(() => {});
                onAction();
              }}
            />
          ))}
          <StatusRow
            label={t("Remove from list")}
            danger
            onClick={() => {
              void clearSimklStatus(target).catch(() => {});
              onAction();
            }}
          />
        </>
      )}
    </>
  );
}

export function TraktMenuItems({
  harborId,
  type,
  onAction,
}: {
  harborId: string;
  type: "movie" | "series";
  onAction: () => void;
}) {
  const t = useT();
  const { isConnected, resolveTarget } = useTrakt();
  if (!isConnected || type !== "movie") return null;
  const target = resolveTarget(harborId);
  if (!target || target.kind !== "movie") return null;
  return (
    <button
      role="menuitem"
      onClick={() => {
        void pushWatched(target).catch(() => {});
        onAction();
      }}
      className="flex h-9 items-center gap-2.5 rounded-lg px-3 text-start text-[13px] text-ink transition-colors hover:bg-raised"
    >
      <img src={traktLogo} alt="" className="h-[14px] w-[14px] rounded-[3px] object-contain" />
      <span className="flex-1 truncate">{t("Mark watched on Trakt")}</span>
    </button>
  );
}
