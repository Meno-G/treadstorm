# Putting Treadstorm online

The game is plain static files: any web host that serves files will do. No server code is needed.

## Build
```
npm run build        # creates the dist/ folder
npm run preview      # optional: try the built game at http://localhost:4173
```
`treadstorm-web.zip` is `dist/` already zipped (index.html at the top level).

## Option A: itch.io (free, easiest to share)
1. Create a free account, then "Upload new project".
2. Kind of project: **HTML**. Upload `treadstorm-web.zip`, tick "This file will be played in the browser".
3. Embed size: 1280 x 720 (or wider), tick fullscreen button. Save, then Publish.

## Option B: Netlify (free)
Sign in at netlify.com, open "Sites", drag the `dist` folder (or the zip) into the drop area.
You get a link like https://something.netlify.app straight away.

## Option C: GitHub Pages
Push the contents of `dist/` to a repository and enable Pages. The game uses relative paths, so it also works
from a subfolder such as https://you.github.io/treadstorm/.

## Notes
- Each player's garage progress and settings are saved in their own browser (localStorage), not on a server.
- The menu font is loaded from Google Fonts, so players need an internet connection (it falls back to a system font otherwise).
- New turret/hull models go in `public/models/` (see the comment above `HULL_MODEL_FILES` in main.js).
