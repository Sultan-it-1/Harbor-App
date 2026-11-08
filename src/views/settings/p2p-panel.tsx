import { isPhoneLayout } from "@/lib/platform";
import {
  LocalEngineSection,
  P2PAdvancedSection,
  RemoteServerSection,
  ServerAddressSection,
} from "./player-panel";

// Android app: there is no local torrent engine on the phone; only a streaming server
// elsewhere (a PC, a NAS) can play P2P sources.
const PHONE = isPhoneLayout();

export function P2PPanel() {
  return (
    <>
      {!PHONE && <LocalEngineSection />}
      {!PHONE && <P2PAdvancedSection />}
      <ServerAddressSection />
      <RemoteServerSection />
    </>
  );
}
