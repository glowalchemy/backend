const express = require('express');
const mongoose = require('mongoose');
const { ProductModel } = require('../models/product');
const { resolveAssetUrl } = require('../config/storage');
const { resolveMediaForValues } = require('../services/imageMedia');

const router = express.Router();

function toAbsoluteUrl(req, url) {
  return resolveAssetUrl(req, url);
}

function safeString(v, maxLen = 1000) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function safeEmail(v) {
  const s = safeString(v, 254).toLowerCase();
  if (!s) return '';
  // very basic validation
  if (!/^\S+@\S+\.\S+$/.test(s)) return '';
  return s;
}

function mapAnswer(a) {
  return {
    id: a._id || a.id,
    answer: a.answer,
    sellerName: a.sellerName,
    date: a.date,
    isVerified: !!a.isVerified,
    upvotes: a.upvotes || 0,
  };
}

function mapQuestion(q) {
  const answers = Array.isArray(q.answers) ? q.answers : [];
  return {
    id: q._id || q.id,
    question: q.question,
    customerName: q.customerName,
    customerEmail: q.customerEmail,
    date: q.date,
    answers: answers.map(mapAnswer),
    upvotes: q.upvotes || 0,
    isAnswered: answers.length > 0,
  };
}

function mapReview(r) {
  return {
    id: r._id || r.id,
    rating: r.rating,
    title: r.title,
    comment: r.comment,
    customerName: r.customerName,
    date: r.date,
    verifiedPurchase: !!r.verifiedPurchase,
    helpful: r.helpful || 0,
    status: r.status || 'pending',
  };
}

function sortReviews(reviews, sort) {
  const list = Array.isArray(reviews) ? reviews.slice() : [];
  const s = String(sort || 'recent');

  if (s === 'helpful') {
    list.sort((a, b) => (b.helpful || 0) - (a.helpful || 0));
    return list;
  }
  if (s === 'rating-high') {
    list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    return list;
  }
  if (s === 'rating-low') {
    list.sort((a, b) => (a.rating || 0) - (b.rating || 0));
    return list;
  }

  // recent
  list.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
  return list;
}

// GET /api/product-details/:productId/details
router.get('/:productId/details', async (req, res) => {
  try {
    const { productId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ message: 'Invalid product id' });

    }

    const product = await ProductModel.findById(productId);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // Authoritative inventory: management.inventory.stockQuantity with a
    // fallback to the product-level stock field — identical precedence to the
    // catalog API (simple-products.js) so listing and PDP never disagree.
    const inventory = product.management && product.management.inventory ? product.management.inventory : null;
    const stockQty = Number(inventory?.stockQuantity ?? NaN);
    const stock = Number.isFinite(stockQty) ? stockQty : Number(product.stock ?? 0) || 0;

    const colorVariantsRaw = Array.isArray(product.colorVariants) ? product.colorVariants : [];
    const colorVariants = colorVariantsRaw.map((v) => ({
      ...v,
      images: Array.isArray(v?.images) ? v.images.map((img) => toAbsoluteUrl(req, img)).filter(Boolean) : [],
    }));

    // Responsive media metadata: resolve every stored image reference once and
    // attach variants/dimensions so the PDP can render <picture>/srcset.
    const managementMedia = (product.management && product.management.media && Array.isArray(product.management.media.images)
      ? product.management.media.images
      : []);
    const storedPrimary = String(product.image || '').trim();
    const imageValues = [
      storedPrimary,
      ...(Array.isArray(product.galleryImages) ? product.galleryImages.map(String).filter(Boolean) : []),
      ...managementMedia.map((i) => String(i?.url || '').trim()).filter(Boolean),
    ].filter(Boolean);
    const resolvedImages = await resolveMediaForValues(req, imageValues);
    const resolvedByValue = new Map();
    imageValues.forEach((v, idx) => {
      if (resolvedImages[idx]) resolvedByValue.set(v, resolvedImages[idx]);
    });

    const primaryResolved = storedPrimary ? resolvedByValue.get(storedPrimary) : null;
    const image = primaryResolved ? primaryResolved.url : toAbsoluteUrl(req, storedPrimary);
    const imageMedia = primaryResolved
      ? {
          url: primaryResolved.url,
          variants: primaryResolved.variants,
          width: primaryResolved.width,
          height: primaryResolved.height,
        }
      : null;

    const media = managementMedia
      .map((img) => {
        const raw = String(img?.url || '').trim();
        const m = raw ? resolvedByValue.get(raw) : null;
        return {
          id: img?.id || '',
          alt: String(img?.alt || '').trim(),
          url: m ? m.url : toAbsoluteUrl(req, raw),
          variants: m ? m.variants : null,
          width: m ? m.width : null,
          height: m ? m.height : null,
        };
      })
      .filter((e) => e.url);

    return res.json({
      id: String(product._id),
      _id: String(product._id),
      slug: product.slug,
      visibility: product.visibility,
      status: product.status,
      sku: product.sku,
      name: product.name,
      description: product.description,
      descriptionHtml: (product && product.management && product.management.basic && typeof product.management.basic.descriptionHtml === 'string')
        ? product.management.basic.descriptionHtml
        : '',
      price: product.price,
      originalPrice: product.originalPrice || (product.management && product.management.pricing ? (product.management.pricing.originalPrice || 0) : 0),
      image,
      imageMedia,
      media,
      galleryImages: (product.galleryImages || [])
        .map((img) => {
          const resolved = resolvedByValue.get(String(img).trim());
          return resolved ? resolved.url : toAbsoluteUrl(req, img);
        })
        .filter(Boolean),
      brand: (product.management && product.management.basic && typeof product.management.basic.brand === 'string' && product.management.basic.brand.trim())
        ? product.management.basic.brand.trim()
        : (product.brand || ''),
      codAvailable: typeof product.codAvailable === 'boolean' ? product.codAvailable : Boolean(product.management && product.management.shipping && product.management.shipping.codAvailable),
      codCharge: Number(product?.codCharge ?? (product.management && product.management.shipping ? product.management.shipping.codCharge : 0) ?? 0) || 0,
      // Full management doc (product's own data, already returned publicly by the
      // catalog API) so the PDP can render real specs, returns and shipping
      // without a second product request.
      management: product.management,
      category: product.category,
      stock,
      rating: product.rating || 0,
      reviews: Array.isArray(product.reviews) ? product.reviews.length : 0,
      questions: Array.isArray(product.questions) ? product.questions.length : 0,
      keyFeatures: product.keyFeatures || [],
      warranty: product.warranty,
      warrantyDetails: product.warrantyDetails,
      weight: product.weight,
      dimensions: product.dimensions,
      sizes: product.sizes || [],
      colors: product.colors || [],
      colorVariants,
      tags: product.tags || [],
      saleEnabled: product.saleEnabled,
      saleDiscount: product.saleDiscount,
      saleStartDate: product.saleStartDate,
      saleEndDate: product.saleEndDate,
      freeShipping: product.freeShipping,
      shippingCharge: Number(product?.shippingCharge ?? product?.management?.shipping?.shippingCharge ?? 0) || 0,
      metaTitle: product.metaTitle,
      metaDescription: product.metaDescription,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    });
  } catch (error) {
    console.error('Error fetching product details:', error);
    return res.status(500).json({ message: 'Failed to fetch product details' });
  }
});

// GET /api/product-details/:productId/questions
router.get('/:productId/questions', async (req, res) => {
  try {
    const { productId } = req.params;
    const page = Number(req.query.page || 1) || 1;
    const limit = Number(req.query.limit || 10) || 10;
    const skip = (page - 1) * limit;

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ message: 'Invalid product id' });
    }

    const product = await ProductModel.findById(productId).select('questions');
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const all = Array.isArray(product.questions) ? product.questions.slice().reverse() : [];
    const total = all.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const pageItems = all.slice(skip, skip + limit);

    return res.json({
      questions: pageItems.map(mapQuestion),
      page,
      limit,
      total,
      totalPages,
    });
  } catch (error) {
    console.error('Error fetching questions:', error);
    return res.status(500).json({ message: 'Failed to fetch questions' });
  }
});

// POST /api/product-details/:productId/questions
router.post('/:productId/questions', async (req, res) => {
  try {
    const { productId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ message: 'Invalid product id' });
    }

    const question = safeString(req.body?.question, 500);
    const customerName = safeString(req.body?.customerName, 100);
    const customerEmail = safeEmail(req.body?.customerEmail);

    if (!question) return res.status(400).json({ message: 'Question is required' });
    if (!customerName) return res.status(400).json({ message: 'Customer name is required' });
    if (!customerEmail) return res.status(400).json({ message: 'Customer email is required' });

    const newQuestion = {
      _id: new mongoose.Types.ObjectId(),
      question,
      customerName,
      customerEmail,
      date: new Date().toISOString(),
      answers: [],
      upvotes: 0,
    };

    const pushResult = await ProductModel.updateOne(
      { _id: productId },
      { $push: { questions: newQuestion } },
      { runValidators: false },
    );

    if (!pushResult || pushResult.matchedCount === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }

    return res.status(201).json(mapQuestion(newQuestion));
  } catch (error) {
    console.error('Error submitting question:', error);
    return res.status(500).json({ message: 'Failed to submit question' });
  }
});

// POST /api/product-details/questions/:questionId/answers
router.post('/questions/:questionId/answers', async (req, res) => {
  try {
    const { questionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(questionId)) {
      return res.status(400).json({ message: 'Invalid question id' });
    }

    const answer = safeString(req.body?.answer, 1000);
    const sellerName = safeString(req.body?.sellerName, 100);
    const isVerified = !!req.body?.isVerified;

    if (!answer) return res.status(400).json({ message: 'Answer is required' });
    if (!sellerName) return res.status(400).json({ message: 'Seller name is required' });

    const newAnswer = {
      _id: new mongoose.Types.ObjectId(),
      answer,
      sellerName,
      date: new Date().toISOString(),
      isVerified,
      upvotes: 0,
    };

    const result = await ProductModel.updateOne(
      { 'questions._id': questionId },
      { $push: { 'questions.$.answers': newAnswer } },
      { runValidators: false },
    );

    if (!result || result.matchedCount === 0) {
      return res.status(404).json({ message: 'Question not found' });
    }

    return res.status(201).json(mapAnswer(newAnswer));
  } catch (error) {
    console.error('Error submitting answer:', error);
    return res.status(500).json({ message: 'Failed to submit answer' });
  }
});

// POST /api/product-details/questions/:questionId/upvote
router.post('/questions/:questionId/upvote', async (req, res) => {
  try {
    const { questionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(questionId)) {
      return res.status(400).json({ message: 'Invalid question id' });
    }

    const result = await ProductModel.updateOne(
      { 'questions._id': questionId },
      { $inc: { 'questions.$.upvotes': 1 } },
    );

    if (!result || result.modifiedCount === 0) {
      return res.status(404).json({ message: 'Question not found' });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Error upvoting question:', error);
    return res.status(500).json({ message: 'Failed to upvote question' });
  }
});

// GET /api/product-details/:productId/reviews
router.get('/:productId/reviews', async (req, res) => {
  try {
    const { productId } = req.params;
    const page = Number(req.query.page || 1) || 1;
    const limit = Number(req.query.limit || 10) || 10;
    const sort = String(req.query.sort || 'recent');

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ message: 'Invalid product id' });
    }

    const product = await ProductModel.findById(productId).select('reviews rating');
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const all = sortReviews(product.reviews || [], sort);
    const total = all.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const skip = (page - 1) * limit;

    const pageItems = all.slice(skip, skip + limit);

    const computedAvg = (() => {
      const ratings = (product.reviews || [])
        .map((r) => Number(r.rating || 0))
        .filter((n) => Number.isFinite(n) && n > 0);
      const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
      return Math.round(avg * 10) / 10;
    })();

    return res.json({
      reviews: pageItems.map(mapReview),
      page,
      limit,
      total,
      totalPages,
      averageRating: Number.isFinite(Number(product.rating)) && Number(product.rating) > 0 ? Number(product.rating) : computedAvg,
      totalReviews: total,
    });
  } catch (error) {
    console.error('Error fetching reviews:', error);
    return res.status(500).json({ message: 'Failed to fetch reviews' });
  }
});

// POST /api/product-details/:productId/reviews
router.post('/:productId/reviews', async (req, res) => {
  try {
    const { productId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ message: 'Invalid product id' });
    }

    const rating = Number(req.body?.rating);
    const title = safeString(req.body?.title, 200);
    const comment = safeString(req.body?.comment, 2000);
    const customerName = safeString(req.body?.customerName, 100);
    const customerEmail = safeEmail(req.body?.customerEmail);
    const verifiedPurchase = !!req.body?.verifiedPurchase;

    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Invalid rating' });
    }
    if (!title) return res.status(400).json({ message: 'Title is required' });
    if (!comment) return res.status(400).json({ message: 'Comment is required' });
    if (!customerName) return res.status(400).json({ message: 'Customer name is required' });
    if (!customerEmail) return res.status(400).json({ message: 'Customer email is required' });

    const newReview = {
      _id: new mongoose.Types.ObjectId(),
      rating,
      title,
      comment,
      customerName,
      customerEmail,
      date: new Date().toISOString(),
      verifiedPurchase,
      helpful: 0,
      status: 'pending',
    };

    // Important: do NOT call product.save() here.
    // Some older product documents may be missing required fields and Mongoose will throw validation errors.
    // Use an atomic update instead.
    const pushResult = await ProductModel.updateOne(
      { _id: productId },
      { $push: { reviews: newReview } },
      { runValidators: false },
    );

    if (!pushResult || pushResult.matchedCount === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // Best-effort: update cached average rating without triggering full-document validation.
    try {
      const p = await ProductModel.findById(productId).select('reviews.rating');
      if (p && Array.isArray(p.reviews)) {
        const ratings = p.reviews
          .map((r) => Number(r.rating || 0))
          .filter((n) => Number.isFinite(n) && n > 0);
        const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
        await ProductModel.updateOne(
          { _id: productId },
          { $set: { rating: Math.round(avg * 10) / 10 } },
          { runValidators: false },
        );
      }
    } catch (e) {
      console.error('Error updating product rating after review:', e);
    }

    return res.status(201).json({
      id: newReview._id,
      ...mapReview(newReview),
    });
  } catch (error) {
    console.error('Error submitting review:', error);
    return res.status(500).json({
      message: 'Failed to submit review',
      error: process.env.NODE_ENV === 'production' ? undefined : String(error?.message || error),
    });
  }
});

// POST /api/product-details/reviews/:reviewId/helpful
router.post('/reviews/:reviewId/helpful', async (req, res) => {
  try {
    const { reviewId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(reviewId)) {
      return res.status(400).json({ message: 'Invalid review id' });
    }

    const result = await ProductModel.updateOne(
      { 'reviews._id': reviewId },
      { $inc: { 'reviews.$.helpful': 1 } },
    );

    if (!result || result.modifiedCount === 0) {
      return res.status(404).json({ message: 'Review not found' });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Error marking review helpful:', error);
    return res.status(500).json({ message: 'Failed to mark review helpful' });
  }
});

module.exports = router;
