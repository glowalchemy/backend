// Shared image upload pipeline used by /api/upload and banner uploads.
//
//   validate (real content) -> sharp variants (AVIF + WebP, no upscale)
//   -> private B2 original + variants -> canonical metadata in `uploads`
//   -> returns stable proxy URLs + variant metadata (never signed URLs).

const {
    uploadObject,
    proxyPathFor,
    absoluteUrl,
    bucket: STORAGE_BUCKET,
    region: STORAGE_REGION,
} = require('../config/storage');
const {
    validateImageUpload,
    generateVariantBuffers,
    buildAssetKeys,
    newAssetId,
} = require('./imageProcessor');
const { UploadModel } = require('../models/upload');

const FORMAT_EXT = { jpeg: 'jpg', tiff: 'tif' };

/**
 * Process, store and index one uploaded image.
 * @returns response-friendly payload with stable proxy URLs only.
 */
async function processAndStoreImage({
    buffer,
    mimetype = 'application/octet-stream',
    originalName = '',
    folder = 'misc',
    req,
}) {
    const meta = await validateImageUpload({ buffer, size: buffer.length });

    const assetId = newAssetId();
    const ext = FORMAT_EXT[meta.format] || meta.format;
    const keys = buildAssetKeys({ folder, assetId, ext });

    // Private original.
    await uploadObject({ key: keys.original, body: buffer, contentType: mimetype });

    // Immutable variants.
    const variantBuffers = await generateVariantBuffers(buffer, meta.width);
    const variantRecords = [];
    for (const v of variantBuffers) {
        const key = keys.variant(v.slot, v.format);
        await uploadObject({ key, body: v.buffer, contentType: `image/${v.format}` });
        variantRecords.push({ slot: v.slot, width: v.width, format: v.format, key });
    }

    // Primary display object = largest WebP variant (broad compatibility),
    // falling back to the original when no variants were generated.
    const primaryRecord = variantRecords
        .filter((r) => r.format === 'webp')
        .sort((a, b) => b.slot - a.slot)[0];
    const primaryKey = primaryRecord ? primaryRecord.key : keys.original;

    const saved = await UploadModel.create({
        key: keys.original,
        url: absoluteUrl(req, proxyPathFor(primaryKey)),
        bucket: STORAGE_BUCKET,
        region: STORAGE_REGION,
        contentType: mimetype,
        size: buffer.length,
        originalName,
        assetId,
        folder,
        primaryKey,
        originalKey: keys.original,
        width: meta.width,
        height: meta.height,
        format: meta.format,
        variants: variantRecords,
    });

    const variantsMap = {};
    for (const r of variantRecords) {
        variantsMap[r.slot] = variantsMap[r.slot] || { slot: r.slot, width: r.width };
        variantsMap[r.slot][r.format] = absoluteUrl(req, proxyPathFor(r.key));
    }

    return {
        id: String(saved._id),
        key: saved.originalKey,
        url: absoluteUrl(req, proxyPathFor(primaryKey)),
        original: absoluteUrl(req, proxyPathFor(keys.original)),
        width: meta.width,
        height: meta.height,
        format: meta.format,
        variants: variantsMap,
        contentType: mimetype,
        size: buffer.length,
        originalName,
    };
}

module.exports = { processAndStoreImage };
