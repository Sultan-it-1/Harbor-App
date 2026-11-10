import { useEffect } from "react";
import { useProfiles } from "./profiles";
import { useSettings, type ContentFilters } from "./settings";
import { DEFAULT } from "./settings/defaults";
import { useTogether } from "./together/provider";

function sameHideContent(a: ContentFilters, b: ContentFilters): boolean {
  return (
    a.anime === b.anime &&
    a.liveTv === b.liveTv &&
    a.sports === b.sports &&
    a.adult === b.adult
  );
}

export function ProfileIdentitySync() {
  const { activeProfile } = useProfiles();
  const { settings, update } = useSettings();
  const { displayName, setDisplayName } = useTogether();

  useEffect(() => {
    if (!activeProfile) return;
    if (settings.harborColor !== activeProfile.color) {
      update({ harborColor: activeProfile.color });
    }
  }, [activeProfile?.id, activeProfile?.color]);

  useEffect(() => {
    if (!activeProfile) return;
    if (settings.harborAvatar !== activeProfile.avatar) {
      update({ harborAvatar: activeProfile.avatar });
    }
  }, [activeProfile?.id, activeProfile?.avatar]);

  useEffect(() => {
    if (!activeProfile) return;
    if (activeProfile.name && displayName !== activeProfile.name) {
      setDisplayName(activeProfile.name);
    }
  }, [activeProfile?.id, activeProfile?.name]);

  useEffect(() => {
    if (!activeProfile) return;
    // A profile that never set its own filters gets the defaults, not what the profile before
    // it had (a child's filters on an adult's profile, or an adult's open state on a child's).
    const wanted = activeProfile.hideContent ?? DEFAULT.hideContent;
    if (!sameHideContent(settings.hideContent, wanted)) {
      update({ hideContent: wanted });
    }
  }, [activeProfile?.id, activeProfile?.hideContent]);

  return null;
}
