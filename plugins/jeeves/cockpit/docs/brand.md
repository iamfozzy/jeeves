# Jeeves identity

The Signal J pairs a sturdy initial with a single signal dot: a point of focus for the orchestrator. Lavender and orchid match the cockpit's palette. The geometric lowercase wordmark is drawn as paths, so it needs no installed font.

See `brand-preview.png` for the identity on dark and light surfaces and at small sizes.

## Assets

- `public/brand/jeeves-icon.svg`: primary rounded app/header logo.
- `public/brand/jeeves-mark.svg`: transparent color mark.
- `public/brand/jeeves-monochrome.svg`: single-color mark; uses `currentColor` when inlined.
- `public/brand/jeeves-wordmark-dark.svg`: light lettering for dark backgrounds.
- `public/brand/jeeves-wordmark-light.svg`: dark lettering for light backgrounds.
- `public/favicon.svg`, `favicon.ico`, `favicon-{16,32,48}.png`: browser icons.
- `public/apple-touch-icon.png`: 180px Apple touch icon.
- `public/icon-{192,512}.png`: app icons.
- `public/icon-maskable-512.png`: full-bleed icon with an inset mark for OS masking.
- `public/site.webmanifest`: app name, colors, and icon declarations.
- `public/logo.svg`: a copy of `jeeves-icon.svg` at a compatibility path.

The app and the design preview both use these assets.

## Usage

Keep the icon at least 16px and the full wordmark at least 150px wide. Allow clear space of at least one signal-dot diameter. Use the matching light/dark wordmark; do not stretch or rotate it. The icon's graphite tile provides contrast in both themes.

Colors: graphite `#18171d`, lavender `#bca2ff`, orchid `#e480d7`, porcelain `#f5eefc`.

## Export

SVGs are the editable source, drawn as vectors to suit the SVG-based app.

Run `python3 scripts/export-brand-icons.py` on macOS to regenerate PNG and ICO assets using Quick Look and sips. These raster app icons deliberately have square full-bleed backgrounds so operating systems can apply their own masks. The SVG favicon uses rounded corners.

The manifest supplies home-screen branding; it does not add offline behavior.
