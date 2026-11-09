# VcShrink

Vencord userplugin for Vesktop: a video, gif, image or audio file over Discord's upload limit is shrunk with
ffmpeg before it's attached, so it uploads without Nitro. Files under the limit, and files ffmpeg can't help
(zips, documents), are left alone; Discord shows its own too-large error for those.

| Kind | Becomes |
|---|---|
| video | mp4, two-pass x264 at the bitrate that fills the limit over its length; AAC 64–128k by budget; long side capped 1920/1280/854/640 and fps at 60/30 as the bitrate drops; retried lower if it still overshoots |
| gif | gif at 15 fps, 128 colours, 480→200 px wide until it fits; failing that, an mp4 |
| image | jpg (webp when it has transparency), long side 8192→1280 px until it fits |
| audio | mp3 at up to 192k, or Opus in ogg when the budget is under 64k |

A toast says when shrinking starts and what it came to. The name keeps its stem and takes the new extension.

## Settings

- **Limit (MiB)**: 0 (default) uses Discord's own limit for you in that server: 20 MiB without Nitro, more
  with Nitro or a boosted server. Set it to shrink earlier.
- **Preset**: x264 speed, `medium` by default; `slow` looks better at the same size, `veryfast` is quicker.
- **ffmpeg / ffprobe**: binaries, looked up on `PATH` by default.

## How it works

Discord's `promptToUpload` is where paste, drag-and-drop, the + button and other plugins all attach files,
before its size check. A patch (found by its `"Unexpected mismatch between files and file metadata"` error)
awaits `shrinkAll(files, channel)` at its top. That swaps each oversized file for a shrunk `File`, same
count and order so Discord's per-file metadata still lines up, and never throws: on any failure the
original goes through.

The renderer can't spawn processes, so `native.ts` runs in Vesktop's main process: it writes the bytes to a
temp dir, runs ffprobe/ffmpeg, checks the result fits, returns the bytes and deletes the dir. The limit
comes from Discord's own getter (found by `getUserMaxFileSize` + `.features.has(`), floored at the 20 MiB
Discord never goes below.

## Limits

- The whole file crosses IPC to the main process and back in memory, so a multi-GB video needs that much RAM.
- Encoding blocks the attach: a long video can take a while before it appears in the message box.
- Only one file's size is checked; Discord's total-per-message cap isn't.

## Install

Copy or symlink this directory into a Vencord checkout's `src/userplugins/vcShrink`, `pnpm build`, and point
Vesktop's "Vencord Location" at `dist`. `tsconfig.json` extends `../vencord/tsconfig.json`; change that path
for another tree. Needs ffmpeg with libx264, libmp3lame, libopus and libwebp.

## License

GPL-3.0-or-later.
