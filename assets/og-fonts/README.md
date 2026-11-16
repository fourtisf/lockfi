# Link-card fonts

Static TTF subsets of the site's own fonts, for the link cards drawn by the
`opengraph-image.tsx` files under `app/` (CLAUDE.md §32). The image renderer
reads TTF, not the variable WOFF2 the site ships. Made by
`python3 scripts/build-og-fonts.py` after `npm run build`; read at runtime from
the app's working directory (`/var/www/balast` on the server).

| File | Font | Licence |
|---|---|---|
| `sora-700.ttf` | Sora, Bold — © The Sora Project Authors | SIL Open Font License 1.1 |
| `manrope-500.ttf`, `manrope-700.ttf` | Manrope — © The Manrope Project Authors | SIL Open Font License 1.1 |
| `plexmono-600.ttf` | IBM Plex Mono, SemiBold — © IBM Corp. | SIL Open Font License 1.1 |

These are modified versions (instanced and subset) under the OFL, which
permits that; they keep the original copyright notices in their name tables
and are not sold on their own. Licence text: https://openfontlicense.org
