import { describe, expect, it } from 'vitest';
import { libraryRootLabel } from './libraryRootLabel';

describe('libraryRootLabel', () => {
  it('removes only the server hash and preserves the original root ID', () => {
    const item = { rootName: 'Video-af6f4f87' };
    expect(libraryRootLabel(item)).toBe('Video');
    expect(item.rootName).toBe('Video-af6f4f87');
    expect(libraryRootLabel({ rootName: 'Downloads-0123abcd' })).toBe('Downloads');
    expect(libraryRootLabel({ rootName: 'My-Video-0123abcd' })).toBe('My-Video');
  });
  it('keeps local folder names and ordinary names intact', () => {
    expect(libraryRootLabel({ rootName: 'Downloads' })).toBe('Downloads');
    expect(libraryRootLabel({ rootName: 'Video-deadbeef', location: 'local' })).toBe('Video-deadbeef');
    expect(libraryRootLabel({ rootName: '/Users/me/Downloads/', location: 'local' })).toBe('Downloads');
  });
});
