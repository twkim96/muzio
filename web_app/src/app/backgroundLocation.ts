import type { Location } from 'react-router-dom';

export interface BackgroundLocationState {
  backgroundLocation?: Location;
}

export function backgroundLocationFrom(location: Location): Location | null {
  const state = location.state as BackgroundLocationState | null;
  return state?.backgroundLocation ?? null;
}
