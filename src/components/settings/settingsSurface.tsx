import { createContext, useContext, type ReactNode } from "react";

/**
 * Where a settings section is being rendered. On a page every section is a
 * card; inside a detail sheet it is flat content, so a sheet never nests a
 * card inside a card.
 */
export type SettingsSurface = "page" | "sheet";

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
