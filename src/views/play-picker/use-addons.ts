import { useEffect, useState } from "react";
import { fetchInstalledAddons, fetchManifestAt, filterEnabled } from "@/lib/addon-store";
import {
  torboxAddonFor,
  userAddons,
  withDebridKeys,
  type Addon,
} from "@/lib/addons";
import { applyOrderToItems, loadDisplayOrder } from "@/lib/addons-store/reorder";
import type { useSettings } from "@/lib/settings";

type Settings = ReturnType<typeof useSettings>["settings"];

function hasAnyResources(a: Addon): boolean {
  return (a.manifest.resources ?? []).length > 0;
}

function declaresStream(a: Addon): boolean {
  return (a.manifest.resources ?? []).some((r) =>
    typeof r === "string" ? r === "stream" : r.name === "stream",
  );
}

async function resolveManifests(addons: Addon[]): Promise<Addon[]> {
  return Promise.all(
    addons.map(async (a) => {
      if (hasAnyResources(a)) return a;
      const manifest = await fetchManifestAt(a.transportUrl).catch(() => null);
      return manifest ? { ...a, manifest } : a;
    }),
  );
}

/**
 * The stream addons the picker queries: Stremio account addons + installed ones (enabled
 * only, manifests resolved, user display order), debrid keys applied, TorBox auto-added.
 * Shared by the picker hook and the "download season" flow.
 */
export async function loadPickerAddons(
  authKey: string | null,
  settings: Pick<Settings, "rdKey" | "tbKey" | "adKey" | "pmKey" | "dlKey">,
): Promise<{ addons: Addon[]; userHasStreamAddons: boolean }> {
  const debridKeys = {
    rdKey: settings.rdKey,
    tbKey: settings.tbKey,
    adKey: settings.adKey,
    pmKey: settings.pmKey,
    dlKey: settings.dlKey,
  };
  const torbox = torboxAddonFor(settings.tbKey);
  const stremioAddons = filterEnabled(authKey ? await userAddons(authKey).catch(() => []) : []);
  const installed = filterEnabled(await fetchInstalledAddons().catch(() => []));
  const merged: Addon[] = [];
  const idxByUrl = new Map<string, number>();
  for (const a of [...stremioAddons, ...installed]) {
    const existingIdx = idxByUrl.get(a.transportUrl);
    if (existingIdx === undefined) {
      idxByUrl.set(a.transportUrl, merged.length);
      merged.push(a);
      continue;
    }
    if (!hasAnyResources(merged[existingIdx]) && hasAnyResources(a)) {
      merged[existingIdx] = a;
    }
  }
  const resolved = await resolveManifests(merged);
  merged.length = 0;
  merged.push(...resolved);
  const savedOrder = loadDisplayOrder();
  if (savedOrder.length > 0) {
    const ordered = applyOrderToItems(merged, savedOrder);
    merged.length = 0;
    merged.push(...ordered);
  }
  const userStreamCount = merged.filter(declaresStream).length;
  const list = withDebridKeys(merged, debridKeys);
  const existingTorboxIdx = list.findIndex(
    (a) =>
      a.manifest.id === "app.torbox.stremio" ||
      a.transportUrl?.includes("stremio.torbox.app"),
  );
  console.info(
    `[picker] authKey=${authKey ? "yes" : "no"} tbKey=${settings.tbKey ? "set" : "EMPTY"} stremioAddons=${stremioAddons.length} installed=${installed.length} merged=${merged.length} userStreamCount=${userStreamCount} hasTorbox=${existingTorboxIdx >= 0} torboxAutoAddable=${!!torbox}`,
  );
  if (torbox) {
    if (existingTorboxIdx >= 0) {
      const existing = list[existingTorboxIdx];
      if (existing.transportUrl !== torbox.transportUrl) {
        console.info(
          `[picker] overriding stale TorBox URL: ${existing.transportUrl} → ${torbox.transportUrl}`,
        );
        list[existingTorboxIdx] = torbox;
      }
    } else {
      console.info(`[picker] auto-adding TorBox addon: ${torbox.transportUrl}`);
      list.push(torbox);
    }
  }
  console.info(
    `[picker] final addon list (${list.length}): ${list.map((a) => a.manifest.name).join(", ")}`,
  );
  return { addons: list, userHasStreamAddons: userStreamCount > 0 };
}

export function useAddons(authKey: string | null, settings: Settings): {
  addons: Addon[] | null;
  userHasStreamAddons: boolean;
} {
  const [addons, setAddons] = useState<Addon[] | null>(null);
  const [userHasStreamAddons, setUserHasStreamAddons] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadPickerAddons(authKey, settings).then((r) => {
      if (cancelled) return;
      setUserHasStreamAddons(r.userHasStreamAddons);
      setAddons(r.addons);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authKey, settings.rdKey, settings.tbKey, settings.adKey, settings.pmKey, settings.dlKey]);

  return { addons, userHasStreamAddons };
}
