import type { ComponentProps } from "react";
import type { PlayerSnapshot } from "@/lib/player/bridge";
import type { PlayerSrc } from "@/lib/view";
import { CinematicPlayerLoader } from "./cinematic-player-loader";
import { LocalFileError } from "./local-file-error";

export function LoaderLayer({
  src,
  snap,
  isLocalSrc,
  forceShow,
  onCancel,
  engineStats,
  onShowingChange,
  onRetry,
}: {
  src: PlayerSrc;
  snap: PlayerSnapshot;
  isLocalSrc: boolean;
  forceShow: boolean;
  onCancel: () => void;
  engineStats: ComponentProps<typeof CinematicPlayerLoader>["engineStats"];
  onShowingChange: (showing: boolean) => void;
  onRetry: () => void;
}) {
  return (
    <>
      {isLocalSrc && snap.errorCode != null ? null : (
        <CinematicPlayerLoader
          src={src}
          snap={snap}
          forceShow={forceShow}
          onCancel={onCancel}
          engineStats={engineStats}
          onShowingChange={onShowingChange}
        />
      )}

      {isLocalSrc && snap.errorCode != null && (
        <LocalFileError
          path={src.url}
          errorMessage={snap.errorMessage}
          onBack={onCancel}
          onRetry={onRetry}
        />
      )}
    </>
  );
}
