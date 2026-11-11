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

export const ja = {
  ...commonMessages.ja,
  ...libraryMessages.ja,
  ...libraryDetailMessages.ja,
  ...settingsMessages.ja,
  ...browserMessages.ja,
  ...readerMessages.ja,
  ...updatesMessages.ja,
  ...privacyMessages.ja,
  ...onlineMessages["ja"],
  ...opdsMessages.ja,
  ...settingsDetailMessages.ja,
  ...featureGateMessages.ja,
  ...resilienceMessages.ja,
} satisfies Messages;
