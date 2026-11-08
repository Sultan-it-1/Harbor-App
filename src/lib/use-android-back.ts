import { useEffect, useRef } from "react";
import { pushAndroidBackHandler } from "@/lib/android";

/** Android back gesture closes this pop-up (while [open]) instead of leaving the page. */
export function useCloseOnAndroidBack(open: boolean, onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!open) return;
    return pushAndroidBackHandler(() => {
      ref.current();
      return true;
    });
  }, [open]);
}
