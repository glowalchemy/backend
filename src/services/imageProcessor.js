// Server-side image processing pipeline (sharp).
//
// - Validates the actual image content (not just filename/MIME): format,
//   dimensions, megapixels, integrity. Rejects corrupt/bomb-like uploads
//   cleanly before expensive processing.
// - Generates immutable responsive variants: 320 / 640 / 1200 (AVIF primary,
//   WebP fallback). No upscaling, aspect ratio preserved, transparency kept
//   (never forced to JPEG), EXIF stripped (sharp strips metadata by default).
// - Limits are configurable via environment variables.
//
// Key conventions (see also storage.js):
//   uploads/<folder>/<assetId>/original.<ext>          (private original)
//   uploads/<folder>/<assetId>/<slot>.avif | .webp     (immutable variants)
//
// Variant slot rule (deterministic, no upscale, no duplicate-content files):
//   content(slot) = min(slot, originalWidth); a slot is emitted when
//   content >= 320 and content differs from the previous slot's content.
//   e.g. 646px -> [320, 640, 1200(content 646)]; 400px -> [320, 640(content 400)];
//   3000px -> [320, 640, 1200]; 100px -> [] (original is already tiny).

const sharp = require('sharp');
const crypto = require('crypto');

const ALLOWED_INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff', 'svg']);

const LIMITS = {
  maxUploadMb: (() => {
    const n = Number(process.env.MAX_UPLOAD_MB);
    return Number.isFinite(n) && n >= 0.5 ? n : 8;
  })(),
  maxImageMegapixels: (() => {
    const n = Number(process.env.MAX_IMAGE_MEGAPIXELS);
    return Number.isFinite(n) && n >= 1 ? n : 30;
  })(),
  maxImageDimension: (() => {
    const n = Number(process.env.MAX_IMAGE_DIMENSION);
    return Number.isFinite(n) && n >= 100 ? n : 12000;
  })(),
};

const VARIANT_SLOTS = (() => {
  const raw = String(process.env.IMAGE_VARIANT_SIZES || '320,640,1200')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isInteger(n) && n >= 16)
    .sort((a, b) => a - b);
  return raw.length ? raw : [320, 640, 1200];
})();

const AVIF_OPTIONS = { quality: 50, effort: 4, chromaSubsampling: '4:4:4' };
const WEBP_OPTIONS = { quality: 78 };

/** Application-level validation error — mapped to a 400 response. */
class ImageValidationError extends Error {
  constructor(message, code = 'INVALID_IMAGE') {
    super(message);
    this.name = 'ImageValidationError';
    this.code = code;
    this.statusCode = 400;
  }
}

// ---------------------------------------------------------------------------
// Concurrency guard: sharp jobs are async/native; bound concurrent processing
// so a burst of large uploads cannot spike Node memory.
// ---------------------------------------------------------------------------
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const run = (fn) => {
    active += 1;
    return fn().finally(() => {
      active -= 1;
      const next = queue.shift();
      if (next) next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      const task = () => run(fn).then(resolve, reject);
      if (active < max) task();
      else queue.push(task);
    });
}

const processLimiter = createLimiter(Math.max(1, Number(process.env.IMAGE_PROCESS_CONCURRENCY) || 2));

function newSharp(buffer) {
  // limitInputPixels guards against decompression bombs at decode time.
  return sharp(buffer, {
    failOn: 'error',
    limitInputPixels: LIMITS.maxImageMegapixels * 1_000_000,
  });
}

/**
 * Validate the raw upload and return normalized metadata.
 * Rejects: wrong format, unreadable/corrupt images, oversized files,
 * oversized pixel counts, oversized single dimensions.
 */
async function validateImageUpload({ buffer, size }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ImageValidationError('No image data received', 'EMPTY_FILE');
  }
  if (size > LIMITS.maxUploadMb * 1024 * 1024) {
    throw new ImageValidationError(
      `File size ${(size / (1024 * 1024)).toFixed(1)}MB exceeds the ${LIMITS.maxUploadMb}MB upload limit`,
      'FILE_TOO_LARGE'
    );
  }

  let meta;
  try {
    meta = await processLimiter(() => newSharp(buffer).metadata());
  } catch (err) {
    if (String(err && err.message || '').includes('pixel limit')) {
      throw new ImageValidationError(
        `Image exceeds the ${LIMITS.maxImageMegapixels}MP safety limit`,
        'IMAGE_TOO_LARGE'
      );
    }
    throw new ImageValidationError('Invalid or unreadable image file', 'INVALID_IMAGE');
  }

  const format = String(meta.format || '').toLowerCase();
  if (!format || !ALLOWED_INPUT_FORMATS.has(format)) {
    throw new ImageValidationError(`Unsupported image format: ${format || 'unknown'}`, 'UNSUPPORTED_FORMAT');
  }

  const width = Number(meta.width) || 0;
  const height = Number(meta.height) || 0;
  if (width <= 0 || height <= 0) {
    throw new ImageValidationError('Image has no readable dimensions', 'INVALID_IMAGE');
  }

  const megapixels = (width * height) / 1_000_000;
  if (megapixels > LIMITS.maxImageMegapixels) {
    throw new ImageValidationError(
      `Image is too large: ${Math.round(megapixels)}MP exceeds the ${LIMITS.maxImageMegapixels}MP limit`,
      'IMAGE_TOO_LARGE'
    );
  }
  if (Math.max(width, height) > LIMITS.maxImageDimension) {
    throw new ImageValidationError(
      `Image dimension ${Math.max(width, height)}px exceeds the ${LIMITS.maxImageDimension}px limit`,
      'IMAGE_TOO_LARGE'
    );
  }

  return {
    format,
    width,
    height,
    hasAlpha: Boolean(meta.hasAlpha),
    megapixels,
  };
}

/**
 * Decide which variant slots to emit for a given original width.
 * content(slot) = min(slot, originalWidth); emit when content >= 320 and not
 * identical to the previously emitted content.
 */
function chooseVariantSlots(originalWidth) {
  const out = [];
  let previousContent = 0;
  for (const slot of VARIANT_SLOTS) {
    const content = Math.min(slot, originalWidth);
    if (content < 320) break; // original is smaller than a card; no variants
    if (content === previousContent) continue; // duplicate content — skip
    out.push({ slot, width: content });
    previousContent = content;
  }
  return out;
}

/**
 * Generate AVIF + WebP buffers for every applicable variant slot.
 * Single source decode via clone(); EXIF/metadata stripped by sharp defaults;
 * alpha channel preserved automatically for PNG/WebP/AVIF inputs.
 */
async function generateVariantBuffers(buffer, originalWidth) {
  const slots = chooseVariantSlots(originalWidth);
  const jobs = [];
  for (const { slot, width } of slots) {
    jobs.push(
      processLimiter(async () => {
        const base = newSharp(buffer);
        const [avif, webp] = await Promise.all([
          base
            .clone()
            .resize({ width, withoutEnlargement: true })
            .avif(AVIF_OPTIONS)
            .toBuffer(),
          base
            .clone()
            .resize({ width, withoutEnlargement: true })
            .webp(WEBP_OPTIONS)
            .toBuffer(),
        ]);
        return [
          { slot, width, format: 'avif', buffer: avif },
          { slot, width, format: 'webp', buffer: webp },
        ];
      })
    );
  }
  const results = await Promise.all(jobs);
  return results.flat();
}

// ---------------------------------------------------------------------------
// Key builders (matches storage.js conventions; keys pass isSafeKey()).
// ---------------------------------------------------------------------------

function buildAssetKeys({ folder, assetId, ext }) {
  const safeFolder = String(folder || 'misc').replace(/[^a-zA-Z0-9_-]/g, '') || 'misc';
  const safeExt = String(ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const base = `uploads/${safeFolder}/${assetId}`;
  return {
    base,
    original: `${base}/original.${safeExt}`,
    variant: (slot, format) => `${base}/${slot}.${format}`,
  };
}

function newAssetId() {
  return crypto.randomBytes(12).toString('hex');
}

/** True when the key lives in the optimized asset namespace uploads/<folder>/<id>/. */
function isOptimizedAssetKey(key) {
  return /^uploads\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9]{16,}\//.test(String(key || ''));
}

/** Extract the assetId from an optimized key, or null. */
function assetIdFromKey(key) {
  const m = /^uploads\/[a-zA-Z0-9_-]+\/([a-zA-Z0-9]{16,})\//.exec(String(key || ''));
  return m ? m[1] : null;
}

/** True when the key names an immutable optimized variant (<slot>.avif|webp). */
function isVariantObjectKey(key) {
  const base = String(key || '').split('/').pop() || '';
  return /^\d+\.(avif|webp)$/i.test(base) && isOptimizedAssetKey(key);
}

module.exports = {
  LIMITS,
  VARIANT_SLOTS,
  ImageValidationError,
  validateImageUpload,
  generateVariantBuffers,
  chooseVariantSlots,
  buildAssetKeys,
  newAssetId,
  isOptimizedAssetKey,
  assetIdFromKey,
  isVariantObjectKey,
};
