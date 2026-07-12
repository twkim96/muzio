import { SettingsScreen } from './SettingsScreen';

/**
 * Compatibility deep link for older /settings/backend bookmarks.
 * The canonical settings surface now lives at /settings and includes the
 * backend probe as a section.
 */
export function BackendStatusScreen() {
  return <SettingsScreen />;
}
