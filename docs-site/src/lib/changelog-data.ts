/**
 * The parsed release history, as one import.
 *
 * A separate module from both the parser and the viewer for two reasons.
 *
 * **It is the only place that knows where the data lives.** `?raw` is a Vite
 * feature: the specifier resolves inside Astro's pipeline and nowhere else, so
 * every module that names it becomes a module that can only be loaded by a
 * bundler. Confining that to one file means the parser stays a pure function
 * over a string and the viewer stays a component over an array — and a test can
 * substitute a fixture for this module without having to teach its runner what
 * `?raw` means.
 *
 * **It parses once per page load rather than once per render.** Ninety-eight
 * releases and about two thousand entries is a few milliseconds; doing it inside
 * the component would repeat it on every keystroke in the search field.
 *
 * The source is the repository's own `CHANGELOG.md`, not a generated JSON copy
 * under `src/data/`. A generated copy goes stale the moment somebody tags a
 * release without re-running the generator, and "the changelog is missing the
 * last three versions" is invisible to a build.
 */

import raw from "../../../CHANGELOG.md?raw";
import { parseChangelog, type Release } from "./changelog";

export const RELEASES: Release[] = parseChangelog(raw);
