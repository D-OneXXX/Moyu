import { commonMessages } from "../messages/common";
import { libraryMessages } from "../messages/library";
import { libraryDetailMessages } from "../messages/libraryDetail";
import { settingsMessages } from "../messages/settings";
import { browserMessages } from "../messages/browser";
import { readerMessages } from "../messages/reader";
import { updatesMessages } from "../messages/updates";
import { privacyMessages } from "../messages/privacy";
import { resilienceMessages } from "../messages/resilience";
import { onlineMessages } from "../messages/online";
import { opdsMessages } from "../messages/opds";
import { settingsDetailMessages } from "../messages/settingsDetail";
import { featureGateMessages } from "../messages/featureGate";
import type { Messages } from "./zh-CN";

export const es = {
  ...commonMessages.es,
  ...libraryMessages.es,
  ...libraryDetailMessages.es,
  ...settingsMessages.es,
  ...browserMessages.es,
  ...readerMessages.es,
  ...updatesMessages.es,
  ...privacyMessages.es,
  ...onlineMessages["es"],
  ...opdsMessages.es,
  ...settingsDetailMessages.es,
  ...featureGateMessages.es,
  ...resilienceMessages.es,
} satisfies Messages;
