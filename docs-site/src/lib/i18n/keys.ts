/**
 * The union of every key the interface can address.
 *
 * Two dictionaries, one key space. `strings.ts` owns the tab strip, the four tab
 * searches, the site search, the settings search and the regex builder in the
 * five documentation locales; `deck.ts` adds the changelog viewer, the settings
 * page, the notifications and the dim sum card. A caller sees one `t()` over the
 * union and never has to know which file a key came from.
 *
 * Its own module purely to break a cycle: `voice.ts` needs the key type and
 * `index.ts` needs `voice`, so the type cannot live in `index.ts` without the two
 * importing each other. Type-only, so it disappears at build.
 */

import type { DeckKey } from "./deck";
import type { StringKey } from "../strings";

export type UiKey = DeckKey | StringKey;
export type { DeckKey, StringKey };
