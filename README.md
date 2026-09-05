# Stepic.js

A vanilla JavaScript implementation of the encoding format used by Python’s STEPIC image steganography library.

Stepic.js embeds messages or binary data into images and extracts data from STEPIC-encoded PNG files. It runs locally in the browser without external JavaScript dependencies.

Try the live demo at: https://dzimbeck.github.io/stepic-js

## Features

- Encode text or binary data into an image.
- Decode STEPIC payloads into raw bytes or text.
- Automatically convert supported carrier images when necessary.
- Save encoded images as PNG files.
- Use UTF-8 or Latin-1 text encoding.
- Inspect image dimensions and payload capacity.
- Includes a demonstration interface for encoding, decoding, and downloading results.

## How It Works

STEPIC stores data in the least-significant bits of the image’s red, green, and blue channels.

Each message byte uses three pixels:

- Eight RGB channel bits store the byte, most-significant bit first.
- The ninth channel bit indicates whether it is the final byte.
- Alpha channels are not used for message storage.

The maximum payload size is:

```text
capacity in bytes = floor(width × height / 3)
```

This implementation follows the payload layout of the supplied Python STEPIC version 0.3. Identical message bytes use the same RGB bit layout, although PNG compression, metadata, and file contents may differ.

**Steganography is not encryption.** STEPIC does not encrypt data or authenticate messages, and an apparent end marker does not prove that an image contains an intentional payload.

## Supported Images

### Encoding

The library reads these carrier images directly:

- 8-bit-per-channel, non-interlaced RGB PNG.
- 8-bit-per-channel, non-interlaced RGBA PNG.

Other images are converted to 8-bit RGBA before encoding, provided the browser can decode them. Examples include:

- JPEG.
- BMP.
- Palette or grayscale PNG.
- Interlaced PNG.
- 16-bit-per-channel PNG.
- Other browser-supported image formats.

Conversion may reduce color precision or change pixel values. Animated carriers become a single static image. Converted images do not retain source metadata.

Output is always an **8-bit-per-channel, non-interlaced PNG**. The original input file is not modified.

### Decoding

Decoding accepts only **8-bit-per-channel, non-interlaced RGB or RGBA PNG files**.

Encoded images are read directly rather than converted, preserving the bits that contain the payload.

## Requirements

Use a browser supporting:

- `CompressionStream` and `DecompressionStream`.
- `Blob`, typed arrays, `TextEncoder`, and `TextDecoder`.
- `createImageBitmap` and a 2D canvas for automatic carrier conversion.

No package installation or `pako` dependency is required.

## Include in a Project

Copy `stepic.js` into your project and load it before your application code:

```html
<script src="./stepic.js"></script>
```

The library exposes a global `Stepic` object.

To use the included demo, place `stepic.html` and `stepic.js` in the same directory and open the HTML page in a supported browser.

## Basic Usage

Image arguments accept a `File`, `Blob`, `ArrayBuffer`, or `Uint8Array` containing the source image file.

### Encode a Message

```javascript
// For example: const imageFile = fileInput.files[0];

const png = await Stepic.encode(imageFile, "Hello from Stepic!");
```

The result is a PNG `Blob`. Strings are encoded as UTF-8 by default.

To use Latin-1:

```javascript
const png = await Stepic.encode(imageFile, "Hello", {
    encoding: "latin1"
});
```

For binary payloads, pass a `Uint8Array` or `ArrayBuffer`:

```javascript
const payload = new Uint8Array([0x00, 0x41, 0xFF]);
const png = await Stepic.encode(imageFile, payload);
```

### Download the Encoded PNG

Before proceeding it is important to be aware that whenever the encoded image is sent or posted somewhere that it should not be compressed or changed because that can destroy the hidden data.


```javascript
const url = URL.createObjectURL(png);
const link = document.createElement("a");

link.href = url;
link.download = "encoded.png";

document.body.appendChild(link);
link.click();
link.remove();

setTimeout(() => URL.revokeObjectURL(url), 60000);
```

### Decode Raw Bytes

```javascript
const bytes = await Stepic.decode(encodedPNG);
// Returns a Uint8Array.
```

### Decode Text

```javascript
const text = await Stepic.decodeText(encodedPNG);
const latin1Text = await Stepic.decodeText(encodedPNG, "latin1");
```

UTF-8 decoding rejects invalid UTF-8 data. Use raw bytes when the payload is binary or its text encoding is unknown.

### Check Carrier Capacity

For an image you intend to encode:

```javascript
const info = await Stepic.info(imageFile, {
    forEncoding: true
});

console.log(info.width, info.height);
console.log(info.capacity);  // Maximum payload size in bytes.
console.log(info.converted); // Whether carrier conversion was needed.
```

Without `forEncoding: true`, `info()` accepts only the PNG formats supported for direct decoding:

```javascript
const info = await Stepic.info(encodedPNG);
```

### Convert Between Text and Bytes

```javascript
const bytes = Stepic.textToBytes("Hello", "utf-8");
const text = Stepic.bytesToText(bytes, "utf-8");
```

Both helpers also accept `"latin1"`. Latin-1 encoding rejects characters outside its byte range.

## Error Handling

Image operations are asynchronous and reject their promises when processing fails:

```javascript
try {
    const png = await Stepic.encode(imageFile, "My message");
    // Use or download the PNG.
} catch (error) {
    console.error(error.message);
}
```

Errors include unsupported inputs, malformed image data, empty messages, insufficient carrier capacity, missing browser APIs, and missing STEPIC end markers.

## Limits and Compatibility Notes

- Input image files are limited to 64 MiB.
- Additional decoded-pixel and scanline size limits apply.
- Browser memory and image-decoding limits may prevent processing large images.
- Message capacity is measured in bytes, not characters.
- Python byte-string compatibility requires using the same payload bytes. JavaScript strings default to UTF-8.
- Encoding preserves alpha samples on the direct RGBA path, but does not promise identical alpha behavior to the supplied Python encoder.
- Direct PNG encoding retains selected metadata; other metadata is omitted.
- The demo verifies each encoded result by decoding it and comparing the recovered bytes.

Keep encoded output as PNG. Resizing, lossy conversion, or other pixel-changing edits can destroy the hidden data.