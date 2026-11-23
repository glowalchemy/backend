const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateAdmin, requireAdmin } = require('../middleware/adminAuth');
const {
    uploadObject,
    deleteObjects,
    getSignedDownloadUrl,
    getObjectStream,
    isSafeKey,
    proxyPathFor,
    resolveAssetUrl,
    absoluteUrl,
    region: STORAGE_REGION,
    bucket: STORAGE_BUCKET,
    EXT_MIME,
} = require('../config/storage');
const {
    LIMITS,
    isVariantObjectKey,
} = require('../services/imageProcessor');
const { processAndStoreImage } = require('../services/imageService');
const { UploadModel } = require('../models/upload');
const { ApiError } = require('../lib/apiError');

router.get('/list', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const folder = String(req.query?.folder ?? '').trim();
        const folderSafe = folder && /^[a-zA-Z0-9_-]+$/.test(folder) ? folder : '';

        const filter = folderSafe ? { key: new RegExp(`^uploads/${folderSafe}/`) } : {};

        const docs = await UploadModel.find(filter)
            .sort({ createdAt: -1 })
            .limit(500)
            .lean();

        res.json(
            docs.map((d) => {
                const key = String(d.key ?? '');
                const parts = key.split('/');
                const derivedFolder = parts.length >= 2 && parts[0] === 'uploads' ? parts[1] : '';
                const variants = buildVariantMap(req, d);
                return {
                    id: String(d._id),
                    key,
                    // Resolve stored references (legacy S3 URLs or proxy paths) to
                    // a current, usable proxy URL. Never expose raw presigned URLs.
                    url: resolveAssetUrl(req, d.url),
                    width: Number(d.width || 0) || undefined,
                    height: Number(d.height || 0) || undefined,
                    format: d.format || '',
                    variants,
                    contentType: d.contentType || '',
                    size: Number(d.size || 0),
                    originalName: d.originalName || '',
                    createdAt: d.createdAt,
                    folder: derivedFolder,
                };
            })
        );
    } catch (error) {
        console.error('List uploads error:', error);
        res.status(500).json({ success: false, message: 'Failed to list uploads' });
    }
});

/** Absolute variant URL map { slot: { avif, webp, width } } from an uploads doc. */
function buildVariantMap(req, doc) {
    const variants = Array.isArray(doc && doc.variants) ? doc.variants : [];
    if (variants.length === 0) return undefined;
    const map = {};
    for (const v of variants) {
        const slot = Number(v && v.slot);
        const key = String(v && v.key || '');
        const format = String(v && v.format || '');
        if (!Number.isInteger(slot) || !key || !isSafeKey(key) || !format) continue;
        map[slot] = map[slot] || { slot, width: Number(v.width) || slot };
        map[slot][format] = absoluteUrl(req, proxyPathFor(key));
    }
    return Object.keys(map).length ? map : undefined;
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        // Raise the previous fixed 5MB cap to the configurable application limit.
        fileSize: LIMITS.maxUploadMb * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        const mime = String(file?.mimetype || '').toLowerCase();
        const name = String(file?.originalname || '');
        const ext = name.includes('.') ? `.${name.split('.').pop()}`.toLowerCase() : '';

        const allowedMime = new Set([
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/gif',
            'image/webp',
            'image/avif',
            'image/bmp',
            'image/svg+xml',
            'image/x-icon',
            'image/tiff',
        ]);
        const allowedExt = new Set([
            '.jpg',
            '.jpeg',
            '.png',
            '.gif',
            '.webp',
            '.avif',
            '.bmp',
            '.svg',
            '.ico',
            '.tif',
            '.tiff',
        ]);

        if (mime.startsWith('image/') || allowedMime.has(mime) || allowedExt.has(ext)) {
            cb(null, true);
        } else {
            // A rejected file type is a client error (415), not a server crash.
            // Content is still verified by signature in processAndStoreImage.
            cb(
                new ApiError({
                    status: 415,
                    code: 'UNSUPPORTED_FORMAT',
                    message:
                        'This file type is not supported. Please choose a JPG, PNG, WebP, AVIF, GIF or SVG image.',
                })
            );
        }
    },
});

/** Safe folder from query, defaulting to 'misc'. */
function safeFolder(req) {
    const folder = String(req.query?.folder ?? '').trim();
    return folder && /^[a-zA-Z0-9_-]+$/.test(folder) ? folder : 'misc';
}

/** Shared upload handler for admin + public image uploads. */
async function handleImageUpload(req, res, next) {
    try {
        if (!req.file) {
            throw new ApiError({
                status: 400,
                code: 'EMPTY_FILE',
                message: 'No file was received. Please choose a file and try again.',
            });
        }

        const result = await processAndStoreImage({
            buffer: req.file.buffer,
            mimetype: req.file.mimetype,
            originalName: req.file.originalname,
            folder: safeFolder(req),
            req,
        });

        return res.json({ success: true, message: 'Image uploaded successfully', ...result });
    } catch (error) {
        // Validation failures carry a curated, safe message and a stable code;
        // the central handler maps them to 413/415/422 with a request id.
        if (error && (error.name === 'ImageValidationError' || error.statusCode || error.status)) {
            return next(error);
        }

        // Storage (B2) or processing outage: report it as an upstream failure so
        // the admin upload queue retries it, never as a user mistake.
        const status = error?.$metadata?.httpStatusCode;
        console.error('Upload error:', { requestId: req.id, operation: 'putObject', status: status || 500, code: error?.name });
        return next(
            new ApiError({
                status: 502,
                code: 'UPLOAD_UNAVAILABLE',
                message: 'Upload failed because the server is temporarily unavailable. Please try again.',
                cause: error,
            })
        );
    }
}

// POST /api/upload/admin-image - Admin image upload
router.post('/admin-image', authenticateAdmin, requireAdmin, upload.single('image'), handleImageUpload);

// POST /api/upload/image - Public image upload (e.g. review images)
router.post('/image', upload.single('image'), handleImageUpload);

// DELETE /api/upload/:id - Permanently delete an upload and its B2 objects.
// Removes the original, the primary display object and every generated
// variant. Object deletion is best-effort: the database record is removed
// even if a storage call fails, and the failure is reported in the response.
router.delete('/:id', authenticateAdmin, requireAdmin, async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid upload id' });
        }

        const doc = await UploadModel.findById(id).lean();
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Upload not found' });
        }

        const keys = new Set();
        for (const k of [doc.key, doc.originalKey, doc.primaryKey]) {
            if (k && isSafeKey(k)) keys.add(k);
        }
        for (const v of Array.isArray(doc.variants) ? doc.variants : []) {
            const k = String(v && v.key || '');
            if (k && isSafeKey(k)) keys.add(k);
        }

        let storageWarning = '';
        try {
            await deleteObjects([...keys]);
        } catch (error) {
            console.error('Upload object cleanup failed:', {
                id,
                failed: error && error.failedObjects ? error.failedObjects.length : 1,
            });
            storageWarning = 'Record deleted but some storage objects could not be removed';
        }

        await UploadModel.findByIdAndDelete(id);

        res.json({
            success: true,
            message: storageWarning || 'Upload deleted successfully',
            ...(storageWarning ? { warning: storageWarning } : {}),
        });
    } catch (error) {
        console.error('Delete upload error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete upload' });
    }
});

// GET /api/upload/file/* - Serve private objects.
//   Immutable optimized variants (uploads/<folder>/<id>/<slot>.avif|webp) are
//   STREAMED server-side with long-lived immutable caching so the browser can
//   reuse them across requests.
//   Everything else (originals, legacy objects like `image.png`) keeps the
//   legacy behavior: fresh presigned GET -> 302 redirect -> private B2.
// Credentials never reach the browser; signed URLs are not logged.
router.get('/file/*', async (req, res) => {
    try {
        const rawKey = String(req.params[0] ?? '');
        const key = decodeURIComponent(rawKey);

        if (!isSafeKey(key)) {
            return res.status(400).json({ success: false, message: 'Invalid file key' });
        }

        if (isVariantObjectKey(key)) {
            // Immutable optimized variant: stream bytes with immutable caching.
            const { body, contentLength, etag } = await getObjectStream(key);
            const extDot = String(key).toLowerCase().match(/\.([a-z0-9]+)$/);
            const contentType = extDot ? EXT_MIME['.' + extDot[1]] : undefined;
            res.status(200);
            res.setHeader('Content-Type', contentType || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            // Variants are served cross-origin to the storefront/admin (frontends
            // live on a different origin than the API), so relax Helmet's default
            // CORP on this route only — exactly like the legacy 302 path below.
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            if (contentLength) res.setHeader('Content-Length', String(contentLength));
            if (etag) res.setHeader('ETag', String(etag));
            body.on('error', () => {
                try {
                    res.destroy();
                } catch (_e) {
                    /* ignore */
                }
            });
            body.pipe(res);
            return;
        }

        // Legacy / original: 302 to a fresh presigned GET.
        const signedUrl = await getSignedDownloadUrl(key);

        // `private` keeps the signed URL out of shared/intermediate caches,
        // while a short max-age lets the SAME browser reuse it. That skips the
        // extra 302 round trip on repeat views (the URL stays valid for an
        // hour, this cache window is 5 minutes).
        res.setHeader('Cache-Control', 'private, max-age=300');

        // Helmet's default `Cross-Origin-Resource-Policy: same-origin` would
        // make Chromium block this redirect when the frontend lives on a
        // different origin than the API (e.g. admin at :8080, API at :5000):
        // cross-origin no-cors image loads are rejected with
        // `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` before the redirect is
        // even followed. This route exists precisely to serve the private
        // object cross-origin (the presigned URL stays server-side and is
        // never exposed to the page), so relax CORP to `cross-origin` for this
        // redirect response only. Every other route keeps Helmet's policy.
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        return res.redirect(302, signedUrl);
    } catch (error) {
        const status = error?.$metadata?.httpStatusCode;
        console.error('Signed download error:', { operation: 'getObject', status: status || 500, code: error?.name });
        if (status === 404 || status === 403) {
            return res.status(404).json({ success: false, message: 'File not found' });
        }
        return res.status(500).json({ success: false, message: 'Failed to load file' });
    }
});

// GET /api/uploads/:filename - Legacy local file serving (disabled).
router.get('/uploads/:filename', (req, res) => {
    res.status(410).json({
        success: false,
        message: 'Local file serving is disabled. Use the returned proxy URL.'
    });
});

module.exports = router;
