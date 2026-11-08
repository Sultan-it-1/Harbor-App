// Pages whose rows are loaded by their own sections (a genre page's rails, each fetching itself):
// the sections hand their rows to the page, which draws them natively in their order. Only what a
// row shows (its titles and cards) redraws the screen; its functions are always the latest.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { NativeRowInput } from "./native-screens";

export type NativeRowSink = {
  set: (id: string, order: number, row: NativeRowInput | null) => void;
};

export const NativeRowSinkContext = createContext<NativeRowSink | null>(null);

type Entry = { order: number; sig: string; row: NativeRowInput };

/** The page's side: the sink (null while the page draws itself) and the rows, in order. */
export function useNativeRowSink(enabled: boolean): [NativeRowSink | null, NativeRowInput[]] {
  const entries = useRef(new Map<string, Entry>());
  const [ver, setVer] = useState(0);
  const sink = useMemo<NativeRowSink | null>(
    () =>
      enabled
        ? {
            set: (id, order, row) => {
              const m = entries.current;
              if (!row) {
                if (m.delete(id)) setVer((v) => v + 1);
                return;
              }
              const sig = [
                order,
                row.title,
                row.sub ?? "",
                row.note ?? "",
                row.grid ? 1 : 0,
                row.lead ? `${row.lead.title}|${row.lead.sub ?? ""}|${(row.lead.img ?? []).join(",")}` : "",
                row.more ? 1 : 0,
                row.metas.map((x) => x.id).join(","),
                // Rows of cards (episodes…): what each card shows, and the row's choices.
                JSON.stringify(row.cards ?? null),
                JSON.stringify(row.chips ?? null),
                JSON.stringify(row.tools ?? null),
                JSON.stringify(row.credits ?? null),
              ].join("|");
              const prev = m.get(id);
              m.set(id, { order, sig, row });
              if (!prev || prev.sig !== sig) setVer((v) => v + 1);
            },
          }
        : null,
    [enabled],
  );
  const rows = useMemo(() => {
    void ver;
    return [...entries.current.entries()]
      .sort((a, b) => a[1].order - b[1].order)
      .map(([id, e]) => {
        const latest = () => entries.current.get(id)?.row;
        return {
          ...e.row,
          more: e.row.more ? () => latest()?.more?.() : undefined,
          onLead: e.row.onLead ? () => latest()?.onLead?.() : undefined,
          onOpen: e.row.onOpen ? (i: number) => latest()?.onOpen?.(i) : undefined,
          onAll: e.row.onAll ? () => latest()?.onAll?.() : undefined,
          onRowChip: e.row.onRowChip ? (x: string) => latest()?.onRowChip?.(x) : undefined,
          onTool: e.row.onTool ? (x: string) => latest()?.onTool?.(x) : undefined,
          onAction: e.row.onAction ? (a: string, i: number) => latest()?.onAction?.(a, i) : undefined,
        };
      });
  }, [ver]);
  return [sink, rows];
}

/** A section's side: hands its row (null = nothing to show) to the page drawing natively. True
 *  while it does: the section then draws nothing itself. Call it before any early return. */
export function useReportNativeRow(id: string, order: number, row: NativeRowInput | null): boolean {
  const sink = useContext(NativeRowSinkContext);
  useEffect(() => {
    sink?.set(id, order, row);
  });
  useEffect(
    () => () => {
      sink?.set(id, order, null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sink, id],
  );
  return !!sink;
}
