---
title: Branding and link embeds
description: How opencodex derives its application icons and social link preview from one committed product mark, wires them into releases and pages, and verifies the result.
---

opencodex keeps one canonical committed raster mark at `gui/public/logo.png`. The application icon,
installer icon, favicon, and social preview are derivatives of that product-owned source; they are
not framework defaults, files renamed to a different format, or images fetched during a build.

The source is a **512×512, 8-bit RGBA PNG**. `scripts/generate-app-icon.mjs` decodes that source,
composites its transparency onto the documented application background, and deterministically
writes these packaging derivatives:

| Derivative | Contract |
| --- | --- |
| `gui/public/opencodex.png` | A decoded 512×512 PNG for consumers that require a raster application mark. |
| `gui/public/opencodex.ico` | A real ICO container with 16, 24, 32, 48, 64, 128, and 256 pixel, 32-bit entries. |
| `docs-site/public/opencodex.ico` | A byte-identical served copy for the Squirrel metadata URL. |

The generator constructs each ICO image from decoded pixels and writes a PNG payload for every
declared size. It does not change the source file. Re-running it must reproduce both derivatives
byte for byte; a different result means either the source, generator, or generated files have
drifted.

## Desktop package and update wiring

`electron-builder.yml` points the Windows desktop package at `gui/public/opencodex.ico`. The
Squirrel metadata uses the project-controlled HTTPS URL `https://opencodex.me/opencodex.ico` for the icon
shown by installed-application surfaces. These are two distinct consumers: embedding the icon in
the executable does not automatically give Squirrel a reachable update or Add/Remove Programs
icon, and a configured URL does not prove that the executable contains the mark.

Release verification therefore inspects the built setup executable and the application executable
inside the full `.nupkg`. It must find the expected icon resources at both small and standard sizes,
and the hosted ICO URL must return a decodable icon without authentication. Configuration alone is
not packaged-artifact evidence.

The project permanently ships unsigned Windows artifacts. Branding does not change that policy and
must never introduce a certificate, signing key, signer discovery, or a claim that the icon proves
authenticity.

## Social preview derivatives

`scripts/generate-social-preview.mjs` decodes the committed product logo and places it on a
deterministic, locally rendered 1280×640 card. It writes the same bytes to both locations:

| Path | Purpose |
| --- | --- |
| `social-preview.png` | Findable root master for the repository's Social preview setting. |
| `docs-site/public/social-preview.png` | Static asset served by the documentation site. |

`scripts/check-social-preview.mjs` requires both files to have a PNG signature, declare exactly
1280×640 pixels, and be byte-identical. The generator needs the documentation site's pinned `sharp`
dependency, so install the documentation dependencies before running it. The generator performs no
image download and uses no remote font, analytics service, or third-party rendering endpoint.

## Static link metadata

Astro and Starlight emit social metadata directly in server-rendered HTML because link crawlers do
not execute client JavaScript. Starlight supplies each page's own title, description, canonical URL,
type, locale, and site name; the site configuration adds the shared product image contract. Every
page receives:

- `og:title`, `og:description`, `og:url`, `og:type`, and `og:site_name`;
- an absolute HTTPS `og:image` URL plus its real width, height, and descriptive alternative text;
- `twitter:card=summary_large_image` and matching title, description, image, and image alternative;
- light- and dark-theme `theme-color` values.

The canonical deployment uses `https://opencodex.me/social-preview.png`. Project-site deployments
derive the same absolute URL from `DOCS_SITE_URL` and `DOCS_BASE`, so a non-root base path does not
silently turn the image into a 404. Verification reads the built HTML and fetches the published
image anonymously; finding the declarations only in source configuration is not enough.

Link-preview services cache images aggressively. When the meaning of the card changes, publish a
new image URL instead of assuming that replacing bytes at an old URL will invalidate every cache.

## GitHub repository social preview

GitHub's repository-level Social preview is a repository setting and is not currently exposed by
the supported `git` or `gh` command-line interfaces. Automation commits and verifies the root
`social-preview.png`, but a repository administrator must complete the final upload manually:

1. Open **Settings → General → Social preview** for the opencodex repository.
2. Choose **Upload an image**.
3. Select the root-level `social-preview.png` from the verified release commit.
4. Read the repository page back and confirm that the uploaded card shows the opencodex mark.

That manual boundary is not satisfied by committing the file, setting the repository homepage, or
adding Open Graph metadata to the documentation site. Those actions affect different surfaces.

## Failure modes

| Failure | What it means | Recovery |
| --- | --- | --- |
| Generated icon differs after regeneration | The source, generator, or committed derivative drifted. | Review the source change, rerun `bun scripts/generate-app-icon.mjs`, and commit all intended derivatives together. |
| ICO entry is absent, duplicated, out of bounds, or has the wrong decoded size | The container can render incorrectly at one or more Windows shell sizes. | Regenerate it; do not patch its directory by hand or rename a PNG to `.ico`. |
| Root and served social previews differ | The repository card and site card no longer describe the same release. | Run `bun scripts/generate-social-preview.mjs`, then the checker. |
| Metadata dimensions disagree with the decoded PNG | Crawlers were told a false shape and may render the card late or incorrectly. | Correct the generated asset or metadata, then rebuild and inspect the emitted HTML. |
| `og:image` is relative, non-HTTPS, private, or unreachable | Anonymous crawlers cannot obtain the card. | Restore the deployment-aware absolute HTTPS URL and verify an unauthenticated fetch. |
| Source configuration looks correct but built HTML lacks a tag | The metadata never reached the static page. | Treat the documentation build/readback as failed; fix the server-rendered head rather than injecting tags in client code. |
| Packaged executable shows a framework default | Packaging did not consume or embed the generated icon. | Inspect the built executable and `.nupkg`, then repair package wiring before release. |
| GitHub still shows an automatic repository card | The manual repository-setting upload has not been completed or confirmed. | Upload the root file through the repository setting and verify the rendered repository page. |

## Security and privacy

- Branding generation is local and deterministic. It does not upload source images or send them to
  a conversion service.
- The committed source and derivatives contain public product artwork only. Never place user data,
  credentials, local paths, account identifiers, or private screenshots in them.
- Image inputs are decoded and bounded rather than trusted by extension. Invalid payloads fail the
  build without partially replacing a valid derivative.
- Public metadata contains only the product title, description, canonical public URL, and
  accessible description of the public product image.
- A hosted icon URL must be anonymously reachable over HTTPS and controlled by the project. A
  mutable third-party URL is not an acceptable packaging input.
- Application icons identify the product visually; they are not a signature or security boundary.

## Verification

From the repository root, regenerate and run the focused contracts:

```powershell
bun scripts/generate-app-icon.mjs
bun scripts/generate-social-preview.mjs
bun scripts/check-social-preview.mjs
bun test tests/app-icon-contract.test.ts
bun test tests/social-preview-contract.test.ts
bun test tests/open-graph-contract.test.ts
bun test tests/branding-embed-docs-contract.test.ts
```

Then build the documentation site and inspect the emitted HTML:

```powershell
Push-Location docs-site
try {
  bun install --frozen-lockfile
  bun run build
}
finally {
  Pop-Location
}
```

For a release candidate, verify the real Squirrel setup executable, `RELEASES`, full `.nupkg`, and
the application executable extracted from that package. Record the exact commit and hashes beside
the icon-resource and anonymous-URL results. A source preview or a successful package command does
not replace this built-artifact inspection.

The contract tests include deliberate negative fixtures: corrupt PNG signatures and payloads,
missing ICO sizes, out-of-bounds entries, non-identical preview copies, missing metadata, relative
image URLs, and package manifests that fall back to a framework icon must turn the focused test red.
Each fixture lives in a temporary directory and is removed after the assertion, so negative testing
never mutates the committed source or release candidate.

## Suggested articles

- [Renaming the app](/guides/rename-the-app/) — presentation changes that must not alter package or
  application identity.
- [Web Dashboard](/guides/web-dashboard/) — the application chrome that displays the product mark.
- [Super express release](/guides/super-express-release/) — release preparation and evidence for
  packaged artifacts.
- [Installation](/getting-started/installation/) — how users receive the Windows package whose
  identity and icon are verified here.
