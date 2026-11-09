/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 HefKer
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Main-process half of VcShrink: writes the file to a temp dir, runs ffmpeg until the result fits the
// limit, and hands the bytes back. The renderer can't spawn processes, so all of ffmpeg lives here.

import { execFile } from "child_process";
import type { IpcMainInvokeEvent } from "electron";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { extname, join } from "path";

import type { Kind } from "./kind";

export interface ShrinkOptions {
    ffmpeg: string;
    ffprobe: string;
    /** x264 preset: slower packs more quality into the same size. */
    preset: string;
}
export type ShrinkResult =
    | { ok: true; bytes: Uint8Array; name: string; type: string; }
    | { ok: false; error: string; };

/** Share of the limit a bitrate aims at, leaving room for container overhead and x264's overshoot. */
const HEADROOM = 0.92;

class ShrinkError extends Error { }

function run(bin: string, args: string[]) {
    return new Promise<string>((resolve, reject) => {
        execFile(bin, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (!err) return resolve(stdout);
            const tail = (stderr || err.message).trim().split("\n").slice(-3).join("\n");
            reject(new ShrinkError(`${bin} failed: ${tail}`));
        });
    });
}

const size = async (path: string) => (await stat(path)).size;

async function probe(o: ShrinkOptions, path: string, entries: string, streams?: string) {
    const sel = streams ? ["-select_streams", streams] : [];
    return (await run(o.ffprobe, ["-v", "error", ...sel, "-show_entries", entries, "-of", "csv=p=0", path])).trim();
}

async function duration(o: ShrinkOptions, path: string) {
    const d = parseFloat(await probe(o, path, "format=duration"));
    if (!(d > 0)) throw new ShrinkError("can't tell how long it is");
    return d;
}

/** Caps the longer side at `max`, so portrait videos and images shrink like landscape ones. */
const fit = (max: number) => `scale='if(gte(iw,ih),min(iw,${max}),-2)':'if(gte(iw,ih),-2,min(ih,${max}))'`;

/** Two-pass x264 at the bitrate that fills the limit over the video's length; retries lower if it still overshoots. */
async function video(o: ShrinkOptions, dir: string, input: string, limit: number) {
    const dur = await duration(o, input);
    const hasAudio = (await probe(o, input, "stream=index", "a")) !== "";
    const budgetK = limit * 8 / 1000 * HEADROOM / dur;
    const audioK = !hasAudio ? 0 : budgetK > 1000 ? 128 : budgetK > 300 ? 96 : 64;
    const out = join(dir, "out.mp4");
    const log = join(dir, "pass");

    for (const factor of [1, 0.85, 0.7, 0.55]) {
        const videoK = Math.floor(budgetK * factor) - audioK;
        if (videoK < 50) break;
        const longSide = videoK >= 2500 ? 1920 : videoK >= 1200 ? 1280 : videoK >= 500 ? 854 : 640;
        const common = [
            "-hide_banner", "-loglevel", "error", "-y", "-i", input,
            "-vf", `${fit(longSide)},format=yuv420p`, "-fpsmax", videoK >= 1200 ? "60" : "30",
            "-c:v", "libx264", "-preset", o.preset, "-b:v", `${videoK}k`, "-passlogfile", log,
        ];
        await run(o.ffmpeg, [...common, "-pass", "1", "-an", "-f", "null", "-"]);
        await run(o.ffmpeg, [
            ...common, "-pass", "2",
            ...(hasAudio ? ["-c:a", "aac", "-b:a", `${audioK}k`, "-ac", "2"] : ["-an"]),
            "-movflags", "+faststart", out,
        ]);
        if (await size(out) <= limit) return { path: out, ext: ".mp4", type: "video/mp4" };
    }
    throw new ShrinkError(`too long to fit at a watchable bitrate (${Math.round(dur)} s)`);
}

/** Fewer frames, colours and pixels until it fits; a gif has no bitrate to aim at. Too big even small: an mp4. */
async function gif(o: ShrinkOptions, dir: string, input: string, limit: number) {
    const out = join(dir, "out.gif");
    for (const w of [480, 360, 270, 200]) {
        await run(o.ffmpeg, [
            "-hide_banner", "-loglevel", "error", "-y", "-i", input,
            "-vf", `fps=15,${fit(w)}:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer`,
            out,
        ]);
        if (await size(out) <= limit) return { path: out, ext: ".gif", type: "image/gif" };
    }
    return video(o, dir, input, limit);
}

/** jpg, or webp when the image has transparency, shrinking the pixels until it fits. */
async function image(o: ShrinkOptions, dir: string, input: string, limit: number) {
    const pixFmt = await probe(o, input, "stream=pix_fmt", "v:0").catch(() => "");
    // pal8 is how ffmpeg reads paletted pngs, which may have a transparent entry.
    const alpha = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya\d|pal8)/.test(pixFmt);
    const ext = alpha ? ".webp" : ".jpg";
    const out = join(dir, "out" + ext);
    const codec = alpha ? ["-c:v", "libwebp", "-quality", "85"] : ["-q:v", "3"];
    for (const w of [8192, 4096, 2560, 1920, 1280]) {
        await run(o.ffmpeg, [
            "-hide_banner", "-loglevel", "error", "-y", "-i", input,
            "-frames:v", "1", "-vf", fit(w), ...codec, out,
        ]);
        if (await size(out) <= limit) return { path: out, ext, type: alpha ? "image/webp" : "image/jpeg" };
    }
    throw new ShrinkError("still too big at 1280 px");
}

/** mp3 at the bitrate that fills the limit, capped at 192k; below 64k Opus sounds far better, so ogg. */
async function audio(o: ShrinkOptions, dir: string, input: string, limit: number) {
    const dur = await duration(o, input);
    const k = Math.min(192, Math.floor(limit * 8 / 1000 * HEADROOM / dur));
    if (k < 16) throw new ShrinkError(`too long to fit (${Math.round(dur)} s)`);
    const opus = k < 64;
    const ext = opus ? ".ogg" : ".mp3";
    const out = join(dir, "out" + ext);
    await run(o.ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vn", "-map_metadata", "0",
        ...(opus ? ["-c:a", "libopus"] : ["-c:a", "libmp3lame"]), "-b:a", `${k}k`, out,
    ]);
    if (await size(out) > limit) throw new ShrinkError("still too big");
    return { path: out, ext, type: opus ? "audio/ogg" : "audio/mpeg" };
}

const SHRINKERS = { video, gif, image, audio };

/** Shrinks one file's bytes to at most `limit` bytes; the name keeps its stem and takes the new extension. */
export async function shrink(
    _: IpcMainInvokeEvent | null,
    bytes: Uint8Array, name: string, kind: Kind, limit: number, o: ShrinkOptions,
): Promise<ShrinkResult> {
    const dir = await mkdtemp(join(tmpdir(), "vc-shrink-"));
    try {
        const input = join(dir, "in" + (extname(name) || ".bin"));
        await writeFile(input, bytes);
        const res = await SHRINKERS[kind](o, dir, input, limit);
        const stem = name.slice(0, name.length - extname(name).length) || "file";
        return { ok: true, bytes: await readFile(res.path), name: stem + res.ext, type: res.type };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // A missing binary surfaces as spawn ENOENT; say which setting to fix.
        return { ok: false, error: /ENOENT/.test(msg) ? `${msg} (is ffmpeg installed? see the plugin's settings)` : msg };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
