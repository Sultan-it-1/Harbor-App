import { lazy, Suspense } from "react";
import type { Meta } from "@/lib/cinemeta";

// The corner looks titles up in the bundled award history, about 420 KB of JSON. Every hero on
// Home imports the corner, so that JSON used to be part of the first bundle the app has to load
// and parse at every start. Loaded on demand it stays out of it; the corner (which waits for an
// award lookup anyway) just appears a moment later.
const Body = lazy(() => import("./meta-awards-corner-body").then((m) => ({ default: m.MetaAwardsCornerBody })));

export function MetaAwardsCorner(props: { meta: Meta; imdbId?: string | null }) {
  return (
    <Suspense fallback={null}>
      <Body {...props} />
    </Suspense>
  );
}
