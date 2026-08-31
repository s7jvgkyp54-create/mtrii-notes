import { createContext, useContext, type ReactNode } from "react";

export type NotesDestination =
  | { to: "/" }
  | { to: "/settings" }
  | { to: "/notebook/$id"; params: { id: string } };

export type NotesNavigate = (destination: NotesDestination) => void | Promise<void>;

const fallbackNavigate: NotesNavigate = (destination) => {
  const path =
    destination.to === "/notebook/$id"
      ? `/notebook/${encodeURIComponent(destination.params.id)}`
      : destination.to;
  window.location.assign(path);
};

const NotesNavigationContext = createContext<NotesNavigate>(fallbackNavigate);

export function NotesNavigationProvider({
  navigate,
  children,
}: {
  navigate: NotesNavigate;
  children: ReactNode;
}) {
  return (
    <NotesNavigationContext.Provider value={navigate}>
      {children}
    </NotesNavigationContext.Provider>
  );
}

export function useNotesNavigate() {
  return useContext(NotesNavigationContext);
}
