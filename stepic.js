/*
 * STEPIC browser library.
 *
 * Wire format matches the supplied stepic.py:
 * - Three RGB pixels per payload byte.
 * - First eight channel LSBs store the byte, most-significant bit first.
 * - Ninth channel LSB marks the final byte.
 * - Alpha is not used for payload data.
 *
 * Decoding:
 *   8-bit, non-interlaced RGB and RGBA PNG.
 *
 * Encoding:
 *   Compatible PNGs are read directly.
 *   Other browser-decodable images are converted to 8-bit RGBA
 *   BEFORE embedding. Output is always a non-interlaced PNG.
 *
 * RGB tRNS transparency is expanded to alpha when encoding.
 * Selected color/display metadata is retained on the direct PNG path.
 * Converted carriers retain no source metadata.
 * Animated carriers become a static default image or first frame.
 * Animated PNGs remain unsupported for decoding.
 *
 * Requires native CompressionStream / DecompressionStream.
 * Automatic carrier conversion also requires createImageBitmap and canvas.
 *
 * API:
 *   await Stepic.info(file)
 *   await Stepic.info(file, { forEncoding: true })
 *   await Stepic.encode(file, "Hello")             -> Blob
 *   await Stepic.encode(file, new Uint8Array(...)) -> Blob
 *   await Stepic.decode(file)                     -> Uint8Array
 *   await Stepic.decodeText(file)                 -> string
 *
 * Image inputs: File, Blob, ArrayBuffer, Uint8Array.
 * Message inputs: string, ArrayBuffer, Uint8Array.
 * Text encodings: "utf-8" (default), "latin1".
 */

(function (global) {
    "use strict";

    const SIGNATURE = new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10
    ]);

    // Deliberate resource limits for a browser-side library.
    const MAX_FILE_BYTES = 64 * 1024 * 1024;
    const MAX_RAW_BYTES = 64 * 1024 * 1024;

    // Only this error permits the encoder to try browser conversion.
    class UnsupportedPNGError extends Error {}

    const RETAIN_CHUNKS = new Set([
        "cHRM", "gAMA", "iCCP", "sRGB", "pHYs"
    ]);

    const CRC_TABLE = new Uint32Array(256);

    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1)
                ? (0xEDB88320 ^ (c >>> 1))
                : (c >>> 1);
        }
        CRC_TABLE[n] = c >>> 0;
    }

    function crc32(bytes) {
        let crc = 0xFFFFFFFF;
        for (const byte of bytes) {
            crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    async function imageBytes(input) {
        if (input instanceof Blob) {
            if (input.size > MAX_FILE_BYTES) {
                throw new Error("Image exceeds the 64 MiB input limit.");
            }
            return new Uint8Array(await input.arrayBuffer());
        }

        let bytes;

        if (input instanceof Uint8Array) {
            bytes = input;
        } else if (input instanceof ArrayBuffer) {
            bytes = new Uint8Array(input);
        } else {
            throw new TypeError(
                "Image must be a File, Blob, ArrayBuffer, or Uint8Array."
            );
        }

        if (bytes.byteLength > MAX_FILE_BYTES) {
            throw new Error("Image exceeds the 64 MiB input limit.");
        }

        // Snapshot caller-owned data before asynchronous processing.
        return bytes.slice();
    }

    function parsePNG(bytes) {
        if (!SIGNATURE.every((byte, i) => bytes[i] === byte)) {
            throw new Error("Invalid PNG signature.");
        }

        const view = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
        );

        const idat = [];
        const metadata = [];
        const seenMetadata = new Set();

        let header = null;
        let transparency = null;
        let offset = 8;
        let seenIDAT = false;
        let closedIDAT = false;
        let seenIEND = false;
        let seenPLTE = false;

        while (offset < bytes.length) {
            if (bytes.length - offset < 12) {
                throw new Error("Truncated PNG chunk.");
            }

            const length = view.getUint32(offset);
            const end = offset + length + 12;

            if (length > 0x7FFFFFFF || end > bytes.length) {
                throw new Error("Invalid PNG chunk length.");
            }

            const typeBytes = bytes.subarray(offset + 4, offset + 8);
            const type = String.fromCharCode(...typeBytes);

            if (!/^[A-Za-z]{4}$/.test(type) || (typeBytes[2] & 32)) {
                throw new Error("Invalid PNG chunk type.");
            }

            const data = bytes.subarray(offset + 8, end - 4);
            const expectedCRC = view.getUint32(end - 4);

            if (
                crc32(bytes.subarray(offset + 4, end - 4)) !== expectedCRC
            ) {
                throw new Error(`PNG checksum mismatch in ${type}.`);
            }

            if (!header && type !== "IHDR") {
                throw new Error("IHDR must be the first PNG chunk.");
            }

            if (seenIDAT && type !== "IDAT") {
                closedIDAT = true;
            }

            if (type === "IHDR") {
                if (header || length !== 13) {
                    throw new Error("Invalid or duplicate IHDR.");
                }

                const hv = new DataView(
                    data.buffer,
                    data.byteOffset,
                    data.byteLength
                );

                const width = hv.getUint32(0);
                const height = hv.getUint32(4);
                const bitDepth = data[8];
                const colorType = data[9];

                if (
                    !width ||
                    !height ||
                    width > 0x7FFFFFFF ||
                    height > 0x7FFFFFFF
                ) {
                    throw new Error("Invalid PNG dimensions.");
                }

                if (
                    data[10] !== 0 ||
                    data[11] !== 0 ||
                    data[12] > 1
                ) {
                    throw new Error(
                        "Invalid PNG compression, filter, or interlace method."
                    );
                }

                if (
                    bitDepth !== 8 ||
                    (colorType !== 2 && colorType !== 6) ||
                    data[12] !== 0
                ) {
                    throw new UnsupportedPNGError(
                        "Use an 8-bit, non-interlaced RGB or RGBA PNG. " +
                        "Palette, grayscale, 16-bit, and interlaced PNGs " +
                        "are not supported for direct decoding."
                    );
                }

                const channels = colorType === 6 ? 4 : 3;
                const rawLength = (width * channels + 1) * height;

                if (
                    !Number.isSafeInteger(rawLength) ||
                    rawLength > MAX_RAW_BYTES ||
                    width * height * 4 > MAX_RAW_BYTES
                ) {
                    throw new Error(
                        "Image exceeds the decoded-image memory limit."
                    );
                }

                header = {
                    width,
                    height,
                    channels,
                    rawLength,
                    bitDepth,
                    colorType
                };
            } else if (type === "IDAT") {
                if (closedIDAT) {
                    throw new Error(
                        "PNG IDAT chunks must be consecutive."
                    );
                }

                seenIDAT = true;
                idat.push(data);
            } else if (type === "IEND") {
                if (length !== 0 || !seenIDAT) {
                    throw new Error("Invalid PNG end chunk.");
                }

                seenIEND = true;
                offset = end;
                break;
            } else if (type === "PLTE") {
                if (
                    seenPLTE ||
                    seenIDAT ||
                    !length ||
                    length > 768 ||
                    length % 3 !== 0
                ) {
                    throw new Error("Invalid PNG palette chunk.");
                }

                seenPLTE = true;

                // An optional truecolor palette does not define pixel data.
            } else if (type === "tRNS") {
                if (
                    transparency ||
                    seenIDAT ||
                    header.colorType !== 2 ||
                    length !== 6
                ) {
                    throw new Error("Invalid PNG transparency chunk.");
                }

                const tv = new DataView(
                    data.buffer,
                    data.byteOffset,
                    data.byteLength
                );

                transparency = [
                    tv.getUint16(0),
                    tv.getUint16(2),
                    tv.getUint16(4)
                ];

                if (transparency.some(value => value > 255)) {
                    throw new Error("Invalid 8-bit transparency color.");
                }
            } else if (
                type === "acTL" ||
                type === "fcTL" ||
                type === "fdAT"
            ) {
                throw new UnsupportedPNGError(
                    "Animated PNGs are not supported for direct decoding."
                );
            } else if (RETAIN_CHUNKS.has(type)) {
                if (seenIDAT || seenMetadata.has(type)) {
                    throw new Error(
                        `Invalid ${type} chunk placement.`
                    );
                }

                seenMetadata.add(type);
                metadata.push({ type, data });
            } else if (!(typeBytes[0] & 32)) {
                throw new Error(
                    `Unsupported critical PNG chunk: ${type}.`
                );
            }

            offset = end;
        }

        if (
            !header ||
            !seenIDAT ||
            !seenIEND ||
            offset !== bytes.length
        ) {
            throw new Error(
                "Incomplete PNG or unexpected trailing data."
            );
        }

        return {
            ...header,
            idat,
            metadata,
            transparency
        };
    }

    function paeth(a, b, c) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);

        if (pa <= pb && pa <= pc) return a;
        return pb <= pc ? b : c;
    }

    async function inflatePNG(parts, expectedLength) {
        if (typeof DecompressionStream !== "function") {
            throw new Error(
                "This browser does not support DecompressionStream."
            );
        }

        const stream = new Blob(parts).stream().pipeThrough(
            new DecompressionStream("deflate")
        );

        const reader = stream.getReader();
        const output = new Uint8Array(expectedLength);
        let offset = 0;

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                if (value.length > output.length - offset) {
                    throw new Error(
                        "PNG expands beyond its declared dimensions."
                    );
                }

                output.set(value, offset);
                offset += value.length;
            }

            if (offset !== expectedLength) {
                throw new Error("PNG scanline data is incomplete.");
            }

            return output;
        } catch (error) {
            try {
                await reader.cancel();
            } catch (_) {
                // Preserve the original error.
            }
            throw error;
        } finally {
            reader.releaseLock();
        }
    }

    async function readPixels(input) {
        const png = parsePNG(await imageBytes(input));
        const raw = await inflatePNG(png.idat, png.rawLength);
        const stride = png.width * png.channels;
        const pixels = new Uint8Array(stride * png.height);

        for (let y = 0; y < png.height; y++) {
            const inputRow = y * (stride + 1);
            const outputRow = y * stride;
            const filter = raw[inputRow];

            if (filter > 4) {
                throw new Error(
                    `Unsupported PNG scanline filter: ${filter}.`
                );
            }

            for (let x = 0; x < stride; x++) {
                const a = x >= png.channels
                    ? pixels[outputRow + x - png.channels]
                    : 0;

                const b = y > 0
                    ? pixels[outputRow + x - stride]
                    : 0;

                const c = y > 0 && x >= png.channels
                    ? pixels[outputRow + x - stride - png.channels]
                    : 0;

                let predictor = 0;

                if (filter === 1) {
                    predictor = a;
                } else if (filter === 2) {
                    predictor = b;
                } else if (filter === 3) {
                    predictor = Math.floor((a + b) / 2);
                } else if (filter === 4) {
                    predictor = paeth(a, b, c);
                }

                pixels[outputRow + x] =
                    (raw[inputRow + 1 + x] + predictor) & 255;
            }
        }

        return { ...png, pixels };
    }

    async function convertCarrierToRGBA(bytes) {
        if (typeof global.createImageBitmap !== "function") {
            throw new Error(
                "This browser cannot convert carrier images. " +
                "Use an 8-bit, non-interlaced RGB or RGBA PNG instead."
            );
        }

        let bitmap;
        let canvas;

        try {
            try {
                // Detect the image format from its contents.
                // Animated sources use their default image or first frame.
                bitmap = await global.createImageBitmap(
                    new Blob([bytes])
                );
            } catch (_) {
                throw new Error(
                    "The browser could not decode this carrier image. " +
                    "It may be damaged or use an unsupported image format."
                );
            }

            const width = bitmap.width;
            const height = bitmap.height;
            const rawLength = (width * 4 + 1) * height;

            if (
                !width ||
                !height ||
                !Number.isSafeInteger(rawLength) ||
                rawLength > MAX_RAW_BYTES
            ) {
                throw new Error(
                    "Image exceeds the decoded-image memory limit."
                );
            }

            if (typeof global.OffscreenCanvas === "function") {
                canvas = new global.OffscreenCanvas(width, height);
            } else if (global.document) {
                canvas = global.document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
            } else {
                throw new Error(
                    "Carrier conversion requires a browser canvas."
                );
            }

            const context = canvas.getContext("2d", {
                alpha: true,
                willReadFrequently: true
            });

            if (!context) {
                throw new Error(
                    "Could not create a canvas for conversion."
                );
            }

            // All browser pixel conversions happen BEFORE embedding.
            context.drawImage(bitmap, 0, 0);

            const rgba = context.getImageData(
                0, 0, width, height
            ).data;

            if (!(rgba instanceof Uint8ClampedArray)) {
                throw new Error("Expected 8-bit RGBA canvas pixels.");
            }

            // ImageData owns an independent array. Clearing the canvas
            // does not invalidate these pixels.
            const pixels = new Uint8Array(
                rgba.buffer,
                rgba.byteOffset,
                rgba.byteLength
            );

            return {
                width,
                height,
                channels: 4,
                bitDepth: 8,
                colorType: 6,
                rawLength,
                pixels,
                metadata: [],
                transparency: null,
                converted: true
            };
        } finally {
            if (bitmap) bitmap.close();

            if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
            }
        }
    }

    async function readCarrier(input) {
        const bytes = await imageBytes(input);
        const isPNG = SIGNATURE.every(
            (byte, i) => bytes[i] === byte
        );

        if (isPNG) {
            try {
                const png = await readPixels(bytes);
                return { ...png, converted: false };
            } catch (error) {
                // Only unsupported formats trigger conversion.
                // Other errors encountered on the direct path propagate.
                if (!(error instanceof UnsupportedPNGError)) {
                    throw error;
                }
            }
        }

        return convertCarrierToRGBA(bytes);
    }

    function chunk(type, data) {
        const output = new Uint8Array(data.length + 12);
        const view = new DataView(output.buffer);

        view.setUint32(0, data.length);

        for (let i = 0; i < 4; i++) {
            output[4 + i] = type.charCodeAt(i);
        }

        output.set(data, 8);

        view.setUint32(
            output.length - 4,
            crc32(output.subarray(4, output.length - 4))
        );

        return output;
    }

    function normalizeEncoding(encoding) {
        const name = String(encoding).toLowerCase();

        if (name === "utf-8" || name === "utf8") {
            return "utf-8";
        }

        if (name === "latin1" || name === "iso-8859-1") {
            return "latin1";
        }

        throw new Error('Encoding must be "utf-8" or "latin1".');
    }

    function textToBytes(text, encoding = "utf-8") {
        if (typeof text !== "string") {
            throw new TypeError("Text must be a string.");
        }

        if (normalizeEncoding(encoding) === "utf-8") {
            return new TextEncoder().encode(text);
        }

        const bytes = new Uint8Array(text.length);

        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);

            if (code > 255) {
                throw new Error(
                    "This message contains characters outside Latin-1. " +
                    "Choose UTF-8 instead."
                );
            }

            bytes[i] = code;
        }

        return bytes;
    }

    function bytesToText(bytes, encoding = "utf-8") {
        if (!(bytes instanceof Uint8Array)) {
            throw new TypeError("Bytes must be a Uint8Array.");
        }

        if (normalizeEncoding(encoding) === "utf-8") {
            return new TextDecoder(
                "utf-8",
                { fatal: true }
            ).decode(bytes);
        }

        // Direct ISO-8859-1 mapping, not Windows-1252 decoding.
        const parts = [];

        for (let i = 0; i < bytes.length; i += 8192) {
            parts.push(
                String.fromCharCode(
                    ...bytes.subarray(i, i + 8192)
                )
            );
        }

        return parts.join("");
    }

    function payloadBytes(data, encoding) {
        if (typeof data === "string") {
            return textToBytes(data, encoding);
        }

        if (data instanceof Uint8Array) {
            return data.slice();
        }

        if (data instanceof ArrayBuffer) {
            return new Uint8Array(data.slice(0));
        }

        throw new TypeError(
            "Message must be a string, Uint8Array, or ArrayBuffer."
        );
    }

    function capacityOf(png) {
        return Math.floor(png.width * png.height / 3);
    }

    // Map a sequential RGB channel index onto RGB/RGBA storage.
    function channelOffset(index, channels) {
        return Math.floor(index / 3) * channels + index % 3;
    }

    async function info(input, { forEncoding = false } = {}) {
        // Encoding info follows the same preparation path as encode().
        // Default info remains strict for existing encoded PNGs.
        const png = forEncoding
            ? await readCarrier(input)
            : parsePNG(await imageBytes(input));

        return {
            width: png.width,
            height: png.height,
            bitDepth: png.bitDepth,
            colorType: png.colorType,
            capacity: capacityOf(png),
            converted: png.converted === true
        };
    }

    async function decode(input) {
        // Never normalize encoded images through canvas.
        const png = await readPixels(input);
        const capacity = capacityOf(png);
        const output = new Uint8Array(capacity);

        for (let i = 0; i < capacity; i++) {
            const start = i * 9;
            let byte = 0;

            for (let bit = 0; bit < 8; bit++) {
                const offset = channelOffset(
                    start + bit,
                    png.channels
                );

                byte = (byte << 1) | (png.pixels[offset] & 1);
            }

            output[i] = byte;

            const marker = channelOffset(
                start + 8,
                png.channels
            );

            if (png.pixels[marker] & 1) {
                return output.slice(0, i + 1);
            }
        }

        // STEPIC has no signature or authentication. An ordinary image
        // can coincidentally contain an apparent end marker.
        throw new Error(
            "STEPIC end marker not found. " +
            "The image may be incomplete or not STEPIC-encoded."
        );
    }

    async function decodeText(input, encoding = "utf-8") {
        return bytesToText(await decode(input), encoding);
    }

    async function encode(
        input,
        data,
        { encoding = "utf-8" } = {}
    ) {
        const message = payloadBytes(data, encoding);

        if (!message.length) {
            throw new Error("Message must not be empty.");
        }

        if (typeof CompressionStream !== "function") {
            throw new Error(
                "This browser does not support CompressionStream."
            );
        }

        // Compatible PNG: direct pixel reading.
        // Other carrier: browser conversion before embedding.
        const png = await readCarrier(input);
        const capacity = capacityOf(png);

        if (message.length > capacity) {
            throw new Error(
                `Message requires ${message.length} bytes; ` +
                `this image can hold ${capacity} bytes.`
            );
        }

        let pixels = png.pixels;
        let channels = png.channels;

        // Preserve keyed RGB transparency before changing RGB LSBs.
        if (png.transparency) {
            const rgba = new Uint8Array(
                png.width * png.height * 4
            );

            const [r, g, b] = png.transparency;

            for (
                let src = 0, dst = 0;
                src < pixels.length;
                src += 3, dst += 4
            ) {
                rgba[dst] = pixels[src];
                rgba[dst + 1] = pixels[src + 1];
                rgba[dst + 2] = pixels[src + 2];

                rgba[dst + 3] =
                    pixels[src] === r &&
                    pixels[src + 1] === g &&
                    pixels[src + 2] === b
                        ? 0
                        : 255;
            }

            pixels = rgba;
            channels = 4;
        }

        for (let i = 0; i < message.length; i++) {
            const start = i * 9;

            for (let bit = 0; bit < 8; bit++) {
                const offset = channelOffset(
                    start + bit,
                    channels
                );

                pixels[offset] =
                    (pixels[offset] & 254) |
                    ((message[i] >>> (7 - bit)) & 1);
            }

            const marker = channelOffset(start + 8, channels);

            pixels[marker] =
                (pixels[marker] & 254) |
                (i === message.length - 1 ? 1 : 0);
        }

        // Save samples directly. Do not pass encoded pixels through canvas.
        // Filter-0 scanlines prioritize simplicity over compression ratio.
        const stride = png.width * channels;
        const scanlines = new Uint8Array(
            (stride + 1) * png.height
        );

        for (let y = 0; y < png.height; y++) {
            scanlines.set(
                pixels.subarray(y * stride, (y + 1) * stride),
                y * (stride + 1) + 1
            );
        }

        const compressedStream = new Blob(
            [scanlines]
        ).stream().pipeThrough(
            new CompressionStream("deflate")
        );

        const compressed = new Uint8Array(
            await new Response(compressedStream).arrayBuffer()
        );

        const ihdr = new Uint8Array(13);
        const headerView = new DataView(ihdr.buffer);

        headerView.setUint32(0, png.width);
        headerView.setUint32(4, png.height);
        ihdr[8] = 8;
        ihdr[9] = channels === 4 ? 6 : 2;

        const parts = [
            SIGNATURE,
            chunk("IHDR", ihdr)
        ];

        for (const item of png.metadata) {
            parts.push(chunk(item.type, item.data));
        }

        // Split IDAT to avoid a single large temporary chunk allocation.
        for (
            let offset = 0;
            offset < compressed.length;
            offset += 1048576
        ) {
            parts.push(
                chunk(
                    "IDAT",
                    compressed.subarray(offset, offset + 1048576)
                )
            );
        }

        parts.push(chunk("IEND", new Uint8Array()));

        return new Blob(parts, { type: "image/png" });
    }

    global.Stepic = Object.freeze({
        info,
        encode,
        decode,
        decodeText,
        textToBytes,
        bytesToText
    });
})(globalThis);