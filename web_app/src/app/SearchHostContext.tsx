import { createContext, useContext, type ReactNode } from 'react';

/**
 * The shell owns the topbar slot while library screens own search state.
 * Keeping the slot in context lets a screen render its controls without
 * coupling the shell to one particular library implementation.
 */
export const SearchHostContext = createContext<HTMLElement | null>(null);

export function SearchHostProvider({
  children,
  host,
}: {
  children: ReactNode;
  host: HTMLElement | null;
}) {
  return (
    <SearchHostContext.Provider value={host}>
      {children}
    </SearchHostContext.Provider>
  );
}

export function useSearchHost(): HTMLElement | null {
  return useContext(SearchHostContext);
}
