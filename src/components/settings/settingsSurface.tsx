import { createContext, useContext, type ReactNode } from "react";

/**
 * Where a settings section is being rendered. On a page every section is a
 * grouped list; inside a centered dialog it is flat content, so a dialog never
 * nests a bordered group inside a bordered group.
 */
export type SettingsSurface = "page" | "dialog";

const SettingsSurfaceContext = createContext<SettingsSurface>("page");

export function SettingsSurfaceProvider({
  value,
  children,
}: {
  value: SettingsSurface;
  children: ReactNode;
}) {
  return (
    <SettingsSurfaceContext.Provider value={value}>
      {children}
    </SettingsSurfaceContext.Provider>
  );
}

export function useSettingsSurface(): SettingsSurface {
  return useContext(SettingsSurfaceContext);
}
