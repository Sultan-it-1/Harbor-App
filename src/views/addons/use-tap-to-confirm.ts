import { useCallback, useEffect, useState } from "react";

/**
 * Two-tap confirmation for destructive buttons on touch screens (there is no hover there to
 * show "Remove" first): the first tap arms the button, a second tap within a few seconds
 * confirms, and it disarms by itself otherwise.
 */
export function useTapToConfirm(timeoutMs = 3500): {
  armed: boolean;
  arm: () => void;
  disarm: () => void;
} {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), timeoutMs);
    return () => window.clearTimeout(t);
  }, [armed, timeoutMs]);
  const arm = useCallback(() => setArmed(true), []);
  const disarm = useCallback(() => setArmed(false), []);
  return { armed, arm, disarm };
}
