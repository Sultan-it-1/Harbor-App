export function DragClickStage(props: {
  drawMode: boolean;
  pipMode: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onWheelVolume?: (deltaY: number) => void;
  onSeekStep?: (delta: number) => void;
}) {
  const { drawMode, pipMode, onClick, onDoubleClick, onWheelVolume, onSeekStep } = props;
  return (
    <div
      className="pointer-events-auto absolute inset-0 z-[3]"
      onWheel={(e) => {
        if (drawMode || pipMode) return;
        if (e.ctrlKey || e.metaKey) return;
        onWheelVolume?.(e.deltaY);
      }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (drawMode || pipMode) return;
        if (e.button !== 0) return;
        const startX = e.clientX;
        const startY = e.clientY;
        const startTime = Date.now();
        let dragStarted = false;
        const onMove = (ev: MouseEvent) => {
          if (dragStarted) return;
          if (Date.now() - startTime < 150) return;
          const dx = Math.abs(ev.clientX - startX);
          const dy = Math.abs(ev.clientY - startY);
          if (dx > 8 || dy > 8) {
            dragStarted = true;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            import("@tauri-apps/api/window")
              .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
              .catch(() => {});
          }
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          if (!dragStarted) onClick();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      }}
      onDoubleClick={(e) => {
        if (e.target !== e.currentTarget) return;
        if (drawMode || pipMode) return;
        
        const isMobileOrTouch = window.innerWidth <= 768 || navigator.maxTouchPoints > 0;
        if (isMobileOrTouch && onSeekStep) {
          const third = window.innerWidth / 3;
          if (e.clientX < third) {
            onSeekStep(-10);
            return;
          } else if (e.clientX > third * 2) {
            onSeekStep(10);
            return;
          }
        }
        
        onDoubleClick();
      }}
    />
  );
}
