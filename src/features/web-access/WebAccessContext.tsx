import { createContext, useContext, type ReactNode } from "react";
import { useWebAccess, type WebAccessController } from "./useWebAccess";

const WebAccessContext = createContext<WebAccessController | null>(null);

/**
 * One runtime snapshot for both the summary card and the advanced dialog.
 *
 * Before this provider, each component called `useWebAccess()` separately:
 * two status/addresses queries, two event subscriptions, and two independent
 * busy locks. The backend serializes operations, but the UI could briefly show
 * one panel as idle while the other was still starting/stopping. Sharing a
 * single controller keeps the toggle, URL/QR, claims, devices and safe-mode
 * lock in lockstep.
 */
export function WebAccessProvider({ children }: { children: ReactNode }) {
  const controller = useWebAccess();
  return (
    <WebAccessContext.Provider value={controller}>
      {children}
    </WebAccessContext.Provider>
  );
}

export function useWebAccessController(): WebAccessController {
  const controller = useContext(WebAccessContext);
  if (!controller) {
    throw new Error("useWebAccessController must be used inside WebAccessProvider");
  }
  return controller;
}
