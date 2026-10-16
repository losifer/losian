# losian
something wicked

## Run

Static page, no build step. Three.js loads from a CDN; the font is served from `assets/`, so open it over http rather than `file://`:

```sh
npx serve .        # or: python3 -m http.server
```

- `index.html` — page shell and import map (three@0.160.0)
- `main.js` — extruded title, afterburn shaders, embers, grid-tunnel background, bloom
- `assets/fonts/Monoton-Regular.ttf` — Monoton (SIL OFL, see `OFL.txt`)
