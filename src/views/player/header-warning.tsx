import { useT } from "@/lib/i18n";

export function NoAudioWarning(props: {
  onUseMpv: () => void;
  onDismiss: () => void;
  /** Web build: there is no mpv in a browser, so offer an external player / another stream instead. */
  vlcUrl?: string | null;
  onPickAnother?: () => void;
}) {
  const web = props.vlcUrl != null;
  const t = useT();
  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-32 z-30 mx-auto flex max-w-md flex-col items-center gap-3 rounded-2xl border border-white/15 bg-black/75 px-6 py-5 text-center text-white backdrop-blur-xl">
      <p className="text-[14px] leading-snug">
        {web
          ? t("No audio: this stream's audio format (likely Dolby or DTS) can't be played by the browser. Pick another stream or open it in VLC.")
          : t("No audio: this stream's audio format (likely Dolby or DTS) is not supported by the HTML5 engine.")}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {web ? (
          <>
            {props.onPickAnother && (
              <button
                onClick={props.onPickAnother}
                className="rounded-full bg-accent px-4 py-1.5 text-[13px] font-semibold text-canvas transition-colors hover:bg-accent/90"
              >
                {t("Pick another")}
              </button>
            )}
            <a
              href={`vlc://${props.vlcUrl}`}
              className="rounded-full bg-orange-500/85 px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-orange-500"
            >
              VLC
            </a>
          </>
        ) : (
          <button
            onClick={props.onUseMpv}
            className="rounded-full bg-accent px-4 py-1.5 text-[13px] font-semibold text-canvas transition-colors hover:bg-accent/90"
          >
            {t("Use mpv engine")}
          </button>
        )}
        <button
          onClick={props.onDismiss}
          className="rounded-full border border-white/20 px-4 py-1.5 text-[13px] font-medium text-white/85 transition-colors hover:bg-white/10"
        >
          {t("Dismiss")}
        </button>
      </div>
    </div>
  );
}

export function HeaderWarning(props: { onPickAnother: () => void }) {
  const t = useT();
  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-32 z-30 mx-auto flex max-w-md flex-col items-center gap-3 rounded-2xl border border-white/15 bg-black/75 px-6 py-5 text-center text-white backdrop-blur-xl">
      <p className="text-[14px] leading-snug">
        {t("This file is flagged as not web-playable. Try the mpv backend in Settings or pick another stream.")}
      </p>
      <button
        onClick={props.onPickAnother}
        className="rounded-full bg-accent px-4 py-1.5 text-[13px] font-semibold text-canvas transition-colors hover:bg-accent/90"
      >
        {t("Pick another")}
      </button>
    </div>
  );
}
