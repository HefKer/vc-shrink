/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 HefKer
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { showToast } from "@webpack/common";

import { kindOf } from "./kind";

const Native = VencordNative.pluginHelpers.VcShrink as PluginNative<typeof import("./native")>;
const logger = new Logger("VcShrink");

/** Discord's own per-file limit for you in a guild (your Nitro, or the guild's boost tier), in bytes. */
const getMaxFileSize: (guildId?: string | null) => number = findByCodeLazy("getUserMaxFileSize", ".features.has(");
/** Discord never limits a file below this (20 MiB), whatever the getter says. */
const FLOOR = 20 * 1024 * 1024;

const settings = definePluginSettings({
    limitMb: {
        type: OptionType.NUMBER,
        description: "Shrink files over this many MiB. 0 = Discord's own limit for you in that server (20 MiB without Nitro or boosts)",
        default: 0,
    },
    preset: {
        type: OptionType.SELECT,
        description: "Video encoding speed: slower looks better at the same size",
        options: [
            { label: "veryfast", value: "veryfast" },
            { label: "fast", value: "fast" },
            { label: "medium", value: "medium", default: true },
            { label: "slow", value: "slow" },
        ],
    },
    ffmpegPath: {
        type: OptionType.STRING,
        description: "ffmpeg binary",
        default: "ffmpeg",
    },
    ffprobePath: {
        type: OptionType.STRING,
        description: "ffprobe binary",
        default: "ffprobe",
    },
});

function limitFor(channel: Channel) {
    if (settings.store.limitMb > 0) return Math.floor(settings.store.limitMb * 1024 * 1024);
    try {
        return Math.max(FLOOR, getMaxFileSize(channel.getGuildId()));
    } catch (e) {
        logger.warn("Discord's file size limit not found, using 20 MiB", e);
        return FLOOR;
    }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** The shrunk copy of `file`, or `file` itself when it can't be shrunk (Discord then shows its own too-large error). */
async function shrinkOne(file: File, limit: number): Promise<File> {
    const kind = kindOf(file.name, file.type);
    if (!kind) return file;
    showToast({ text: `Shrinking ${file.name} (${mb(file.size)}) to fit ${mb(limit)}…`, variant: "default" });
    const started = Date.now();
    const res = await Native.shrink(new Uint8Array(await file.arrayBuffer()), file.name, kind, limit, {
        ffmpeg: settings.store.ffmpegPath || "ffmpeg",
        ffprobe: settings.store.ffprobePath || "ffprobe",
        preset: settings.store.preset,
    });
    if (!res.ok) {
        logger.error(`Couldn't shrink ${file.name}:`, res.error);
        showToast({ text: `Couldn't shrink ${file.name}: ${res.error}`, variant: "critical" });
        return file;
    }
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    logger.info(`${file.name}: ${mb(file.size)} -> ${res.name} ${mb(res.bytes.byteLength)} in ${secs} s`);
    showToast({ text: `${file.name}: ${mb(file.size)} → ${mb(res.bytes.byteLength)}`, variant: "success" });
    return new File([res.bytes as BlobPart], res.name, { type: res.type, lastModified: file.lastModified });
}

export default definePlugin({
    name: "VcShrink",
    description: "Shrinks videos, gifs, images and audio over Discord's upload limit with ffmpeg before they're attached",
    authors: [{ name: "HefKer", id: 0n }],
    settings,

    patches: [
        {
            // promptToUpload: paste, drop, the + button and plugins all attach files through it, before its size check.
            find: "Unexpected mismatch between files and file metadata",
            replacement: {
                match: /async function\((\i),(\i),\i\)\{(?=let\{filesMetadata:)/,
                replace: "$&$1=await $self.shrinkAll($1,$2);",
            },
        },
    ],

    /** Same count and order as `files`, so Discord's per-file metadata still lines up. Never throws. */
    async shrinkAll(files: FileList | File[], channel: Channel): Promise<FileList | File[]> {
        try {
            const limit = limitFor(channel);
            const list = Array.from(files);
            if (!list.some(f => f.size > limit && kindOf(f.name, f.type))) return files;
            const out: File[] = [];
            for (const f of list) out.push(f.size > limit ? await shrinkOne(f, limit) : f);
            return out;
        } catch (e) {
            logger.error("Shrinking failed, uploading as is", e);
            return files;
        }
    },
});
