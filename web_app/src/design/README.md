# Muzio glass theme

`kit-tokens.css` is copied from the supplied Web Reader design kit. Its glass
material uses 1.5px blur, 90% saturation, 82% contrast, layered shadows and a
164-degree edge highlight. `styles.css` adapts the component recipes to existing
Muzio markup and icons. Catalog demo scripts and generic SVG rules are excluded.

The theme scope lives on `html` so body portals inherit it. Muzio's saved surface,
text, muted and accent colors remain authoritative. Page backgrounds are plain, without a texture. The floating navigation island
uses the kit glass surface and edge highlight; dense overlays retain more opacity
for text legibility. Individual controls retain their original unboxed styling. Pretendard and its OFL license are under `public/fonts`.

| Surface | Integration |
| --- | --- |
| Music, Video, Image | Full-width library, centered floating navigation/search island and drawer navigation |
| Player | Mini dock, full player, transport, volume, sleep timer, scrub preview |
| Video watch | Information/actions, video list and Vidstack menus; contain sizing preserved |
| Settings | Appearance, backend status, media folders, runtime notes |
| Playlists | Queue, playlist drawer, create/rename/delete/add dialogs and row menu |
| Image viewer | Glass controls; image sizing preserved |
| States | Existing loading, error, empty, disabled, selected and keyboard focus behaviors |
| Reader-only UI | Not applicable: book chapters, reader progress jump, translation, annotations |

Reduced transparency and unsupported backdrop filtering use an opaque fallback.
Reduced motion disables decorative transitions. UI testing covers desktop and
320/390px widths; media playback contracts remain covered by existing suites.
