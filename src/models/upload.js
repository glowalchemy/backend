const mongoose = require('mongoose');

const UploadSchema = new mongoose.Schema(
    {
        key: { type: String, required: true },
        url: { type: String, required: true },
        bucket: { type: String, required: true },
        region: { type: String, required: true },
        contentType: { type: String, default: '' },
        size: { type: Number, default: 0 },
        originalName: { type: String, default: '' },
        // Canonical optimized-asset metadata (additive; legacy docs omit these).
        assetId: { type: String, default: '' },
        folder: { type: String, default: 'misc' },
        primaryKey: { type: String, default: '' }, // largest optimized variant key
        originalKey: { type: String, default: '' }, // original object key
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 },
        format: { type: String, default: '' },
        variants: { type: [mongoose.Schema.Types.Mixed], default: [] }, // [{slot,width,format,key}]
    },
    { timestamps: true }
);

const UploadModel = mongoose.models.Upload || mongoose.model('Upload', UploadSchema);

module.exports = { UploadModel, UploadSchema };
