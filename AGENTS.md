# vc-shrink — Vencord userplugin `VcShrink`

Shrinks attachments over Discord's upload limit with ffmpeg. README.md is the source of truth for what each
kind becomes, the patch and limits; keep it in sync.

## Rules
- Build host: the combined tree `../vencord` (plugins symlinked into `src/userplugins/`). Verify with
  `pnpm build` and `npx tsc --noEmit -p .` there. Fix alias trouble from this repo (see `tsconfig.json`), never by editing Vencord.
- `native.ts` runs in Node: test it alone by bundling with `../vencord/node_modules/.bin/esbuild native.ts
  --bundle --platform=node --format=cjs --external:electron` and calling `shrink(null, bytes, name, kind, limit, opts)`.
- The patch and the limit getter match Discord's minified code; when Discord updates, check each still
  matches exactly once (fetch `https://discord.com/app` and its `/assets/*.js`).
- Public repo (GitHub HefKer/vc-shrink): small commits to `main`; push only when the user asks.
