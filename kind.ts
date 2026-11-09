/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 HefKer
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** What ffmpeg can make smaller; anything else is left for Discord to refuse. */
export type Kind = "video" | "gif" | "image" | "audio";

const VIDEO = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpe?g|ts|3gp|ogv)$/i;
const AUDIO = /\.(mp3|wav|flac|ogg|opus|m4a|aac|aiff?|wma)$/i;
const IMAGE = /\.(png|jpe?g|webp|bmp|tiff?|heic|heif|avif)$/i;

/** By extension first, since a pasted or dropped file's MIME type is often empty. */
export function kindOf(name: string, type: string): Kind | null {
    if (/\.gif$/i.test(name) || type === "image/gif") return "gif";
    if (VIDEO.test(name)) return "video";
    if (AUDIO.test(name)) return "audio";
    if (IMAGE.test(name)) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    if (type.startsWith("image/") && type !== "image/svg+xml") return "image";
    return null;
}
