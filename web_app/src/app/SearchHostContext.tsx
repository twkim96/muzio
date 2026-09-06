import { createContext, useContext, type ReactNode } from 'react';

/**
 * The shell owns the topbar slot while library screens own search state.
 * Keeping the slot in context lets a screen render its controls without
 * coupling the shell to one particular library implementation.
 */
export const SearchHostContext = createContext<HTMLElement | null>(null);
const SearchPopoverHostContext = createContext<HTMLElement | null>(null);

export function SearchHostProvider({
  children,
  host,
  popoverHost = null,
}: {
  children: ReactNode;
  host: HTMLElement | null;
  popoverHost?: HTMLElement | null;
}) {
  return (
    <SearchHostContext.Provider value={host}>
      <SearchPopoverHostContext.Provider value={popoverHost}>
        {children}
      </SearchPopoverHostContext.Provider>
    </SearchHostContext.Provider>
  );
}

export function useSearchHost(): HTMLElement | null {
  return useContext(SearchHostContext);
}

export function useSearchPopoverHost(): HTMLElement | null {
  return useContext(SearchPopoverHostContext);
}
