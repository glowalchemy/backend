/**
 * COSMETIC DATA SEED SCRIPT
 * 
 * This script:
 * 1. Removes all fake data (reviews, orders, fake categories, fake banners)
 * 2. Keeps only the admin account
 * 3. Adds cosmetic categories
 * 4. Adds cosmetic products
 */

const dns = require('node:dns');
require('dotenv').config();
const mongoose = require('mongoose');

// Set DNS servers
dns.setServers(['8.8.8.8', '8.8.4.4']);

// Import models
const Product = require('../src/models/product');
const Category = require('../src/models/category');
const Banner = require('../src/models/banner');
const Review = require('../src/models/Review');
const { Order } = require('../src/models/order');
const User = require('../src/models/user');
const Admin = require('../src/models/admin');

// Cosmetic Categories
const cosmeticCategories = [
  {
    name: 'Skincare',
    slug: 'skincare',
    description: 'Premium skincare products including cleansers, moisturizers, serums, and masks',
    image: 'https://images.unsplash.com/photo-1556228720-195a672e8285?w=400&h=300&fit=crop',
    isActive: true
  },
  {
    name: 'Haircare',
    slug: 'haircare',
    description: 'Professional hair care products including shampoos, conditioners, and hair masks',
    image: 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=400&h=300&fit=crop',
    isActive: true
  },
  {
    name: 'Body Care',
    slug: 'body-care',
    description: 'Luxurious body care products including lotions, scrubs, and oils',
    image: 'https://images.unsplash.com/photo-1608248597279-f99d160bfbc8?w=400&h=300&fit=crop',
    isActive: true
  },
  {
    name: 'Face Care',
    slug: 'face-care',
    description: 'Specialized face care products including toners, sunscreens, and treatments',
    image: 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=400&h=300&fit=crop',
    isActive: true
  },
  {
    name: 'Natural Products',
    slug: 'natural-products',
    description: 'Herbal, organic, and vegan cosmetic products',
    image: 'https://images.unsplash.com/photo-1556228578-0d85b6a9be99?w=400&h=300&fit=crop',
    isActive: true
  },
  {
    name: 'Lip Care',
    slug: 'lip-care',
    description: 'Premium lip care products including lip balms and lip glosses',
    image: 'https://images.unsplash.com/photo-1586495777744-4413f21062fa?w=400&h=300&fit=crop',
    isActive: true
  }
];

// Cosmetic Products
const cosmeticProducts = [
  {
    name: 'Rice Water Brightening Face Wash',
    slug: 'rice-water-brightening-face-wash',
    sku: 'GA-RW-001',
    category: 'Skincare',
    description: 'Gentle face wash enriched with rice water for bright and glowing skin. Removes impurities while maintaining natural moisture balance.',
    price: 299,
    originalPrice: 399,
    stock: 100,
    status: 'active',
    visibility: 'visible',
    image: 'https://images.unsplash.com/photo-1620916566650-9427b32c8335?w=600&h=600&fit=crop',
    galleryImages: [
      'https://images.unsplash.com/photo-1620916566650-9427b32c8335?w=600&h=600&fit=crop'
    ],
    tags: ['Face Wash', 'Rice Water', 'Brightening', 'Natural'],
    keyFeatures: ['Rice Water Extract', 'Vitamin E', 'Paraben Free', 'pH Balanced'],
    badge: 'Best Seller',
    brand: 'GlowAlchemy',
    weight: 100,
    dimensions: { length: 5, width: 5, height: 10 },
    saleEnabled: true,
    saleDiscount: 25,
    featured: true
  },
  {
    name: 'Herbal Hair Conditioner',
    slug: 'herbal-hair-conditioner',
    sku: 'GA-HC-001',
    category: 'Haircare',
    description: 'Nourishing hair conditioner with herbal extracts for soft, smooth, and manageable hair. Suitable for all hair types.',
    price: 349,
    originalPrice: 449,
    stock: 80,
    status: 'active',
    visibility: 'visible',
    image: 'https://images.unsplash.com/photo-1570194065340-dc8ea937c859?w=600&h=600&fit=crop',
    galleryImages: [
      'https://images.unsplash.com/photo-1570194065340-dc8ea937c859?w=600&h=600&fit=crop'
    ],
    tags: ['Conditioner', 'Herbal', 'Hair Care', 'Natural'],
    keyFeatures: ['Herbal Extracts', 'Silk Protein', 'Sulfate Free', 'For All Hair Types'],
    badge: 'New',
    brand: 'GlowAlchemy',
    weight: 200,
    dimensions: { length: 6, width: 6, height: 15 },
    saleEnabled: true,
    saleDiscount: 22,
    featured: true
  },
  {
    name: 'Nourishing Shampoo',
    slug: 'nourishing-shampoo',
    sku: 'GA-NS-001',
    category: 'Haircare',
    description: 'Deep cleansing shampoo with natural ingredients for healthy hair growth. Removes dirt and excess oil without stripping natural moisture.',
    price: 279,
    originalPrice: 349,
    stock: 120,
    status: 'active',
    visibility: 'visible',
    image: 'https://images.unsplash.com/photo-1598440947619-2c35fc9ae54e?w=600&h=600&fit=crop',
    galleryImages: [
      'https://images.unsplash.com/photo-1598440947619-2c35fc9ae54e?w=600&h=600&fit=crop'
    ],
    tags: ['Shampoo', 'Hair Care', 'Nourishing', 'Natural'],
    keyFeatures: ['Aloe Vera', 'Vitamin B5', 'Paraben Free', 'Safe for Colored Hair'],
    badge: 'Popular',
    brand: 'GlowAlchemy',
    weight: 200,
    dimensions: { length: 6, width: 6, height: 15 },
    saleEnabled: true,
    saleDiscount: 20,
    featured: true
  },
  {
    name: 'Deep Repair Hair Mask',
    slug: 'deep-repair-hair-mask',
    sku: 'GA-HM-001',
    category: 'Haircare',
    description: 'Intensive hair mask for damaged hair. Repairs and strengthens hair from root to tip with natural protein extracts.',
    price: 449,
    originalPrice: 599,
    stock: 60,
    status: 'active',
    visibility: 'visible',
    image: 'https://images.unsplash.com/photo-1576426863848-c21f53c60b19?w=600&h=600&fit=crop',
    galleryImages: [
      'https://images.unsplash.com/photo-1576426863848-c21f53c60b19?w=600&h=600&fit=crop'
    ],
    tags: ['Hair Mask', 'Repair', 'Deep Conditioning', 'Natural'],
    keyFeatures: ['Keratin', 'Argan Oil', 'Protein Complex', 'Chemical Free'],
    badge: 'Premium',
    brand: 'GlowAlchemy',
    weight: 250,
    dimensions: { length: 7, width: 7, height: 8 },
    saleEnabled: true,
    saleDiscount: 25,
    featured: true
  },
  {
    name: 'Hydrating Body Lotion',
    slug: 'hydrating-body-lotion',
    sku: 'GA-BL-001',
    category: 'Body Care',
    description: 'Luxurious body lotion that deeply moisturizes and nourishes skin. Long-lasting hydration with natural ingredients.',
    price: 329,
    originalPrice: 429,
    stock: 90,
    status: 'active',
    visibility: 'visible',
    image: 'https://images.unsplash.com/photo-1608248597279-f99d160bfbc8?w=600&h=600&fit=crop',
    galleryImages: [
      'https://images.unsplash.com/photo-1608248597279-f99d160bfbc8?w=600&h=600&fit=crop'
    ],
    tags: ['Body Lotion', 'Hydrating', 'Moisturizing', 'Natural'],
    keyFeatures: ['Shea Butter', 'Coconut Oil', 'Vitamin E', '24hr Hydration'],
    badge: 'Best Seller',
    brand: 'GlowAlchemy',
    weight: 200,
    dimensions: { length: 6, width: 6, height: 12 },
    saleEnabled: true,
    saleDiscount: 23,
    featured: true
  },
  {
    name: 'Vitamin C Face Serum',
    slug: 'vitamin-c-face-serum',
    sku: 'GA-FS-001',
    category: 'Face Care',
    description: 'Brightening face serum with Vitamin C for radiant and even-toned skin. Reduces dark spots and improves skin texture.',
    price: 599,
    originalPrice: 799,
    stock: 50,
    status: 'active',
    visibility: 'visible',
    image: 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=600&h=600&fit=crop',
    galleryImages: [
      'https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=600&h=600&fit=crop'
    ],
    tags: ['Serum', 'Vitamin C', 'Brightening', 'Anti-aging'],
    keyFeatures: ['Vitamin C', 'Hyaluronic Acid', 'Antioxidant', 'Paraben Free'],
    badge: 'Premium',
    brand: 'GlowAlchemy',
    weight: 30,
    dimensions: { length: 4, width: 4, height: 10 },
    saleEnabled: true,
    saleDiscount: 25,
    featured: true
  },
  {
    name: 'Organic Face Mask',
    slug: 'organic-face-mask',
    sku: 'GA-FM-001',
    category: 'Face Care',
    description: 'Natural clay face mask for deep cleansing and detoxification. Removes impurities and tightens pores for clear skin.',
    price: 399,
    originalPrice: 499,
    stock: 70,
    status: 'active',
    visibility: 'visible',
    image: 'https://images.unsplash.com/photo-1556228578-0d85b6a9be99?w=600&h=600&fit=crop',
    galleryImages: [
      'https://images.unsplash.com/photo-1556228578-0d85b6a9be99?w=600&h=600&fit=crop'
    ],
    tags: ['Face Mask', 'Clay', 'Detox', 'Organic'],
    keyFeatures: ['Bentonite Clay', 'Tea Tree Oil', 'Aloe Vera', 'Chemical Free'],
    badge: 'Natural',
    brand: 'GlowAlchemy',
    weight: 100,
    dimensions: { length: 5, width: 5, height: 8 },
    saleEnabled: true,
    saleDiscount: 20,
    featured: true
  },
  {
    name: 'Nourishing Lip Balm',
    slug: 'nourishing-lip-balm',
    sku: 'GA-LB-001',
    category: 'Lip Care',
    description: 'Moisturizing lip balm with natural oils for soft and hydrated lips. Protects from dryness and chapping.',
    price: 149,
    originalPrice: 199,
    stock: 150,
    status: 'active',
    visibility: 'visible',
    image: 'https://images.unsplash.com/photo-1586495777744-4413f21062fa?w=600&h=600&fit=crop',
    galleryImages: [
      'https://images.unsplash.com/photo-1586495777744-4413f21062fa?w=600&h=600&fit=crop'
    ],
    tags: ['Lip Balm', 'Moisturizing', 'Natural', 'Organic'],
    keyFeatures: ['Beeswax', 'Coconut Oil', 'Shea Butter', 'Chemical Free'],
    badge: 'Best Seller',
    brand: 'GlowAlchemy',
    weight: 15,
    dimensions: { length: 3, width: 3, height: 2 },
    saleEnabled: true,
    saleDiscount: 25,
    featured: true
  }
];

async function seedDatabase() {
  try {
    console.log('🌱 Starting cosmetic data seed...');

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Step 1: Remove all fake data (keep admin and products)
    console.log('🗑️  Cleaning fake data...');
    
    // Remove fake reviews
    const deletedReviews = await Review.deleteMany({});
    console.log(`   - Deleted ${deletedReviews.deletedCount} reviews`);
    
    // Remove fake orders
    const deletedOrders = await Order.deleteMany({});
    console.log(`   - Deleted ${deletedOrders.deletedCount} orders`);
    
    // Remove fake banners
    const deletedBanners = await Banner.deleteMany({});
    console.log(`   - Deleted ${deletedBanners.deletedCount} banners`);
    
    // Remove fake categories (except cosmetic ones)
    await Category.deleteMany({});
    console.log(`   - Deleted all categories`);
    
    // Remove fake products (except cosmetic ones)
    await Product.deleteMany({});
    console.log(`   - Deleted all products`);

    // Step 2: Add cosmetic categories
    console.log('📦 Adding cosmetic categories...');
    const insertedCategories = await Category.insertMany(cosmeticCategories);
    console.log(`   ✅ Added ${insertedCategories.length} categories`);

    // Step 3: Add cosmetic products
    console.log('📦 Adding cosmetic products...');
    const categoryMap = {};
    insertedCategories.forEach(cat => {
      categoryMap[cat.name] = cat._id;
    });

    const productsWithCategoryIds = cosmeticProducts.map(product => ({
      ...product,
      category: categoryMap[product.category] || categoryMap['Skincare']
    }));

    const insertedProducts = await Product.insertMany(productsWithCategoryIds);
    console.log(`   ✅ Added ${insertedProducts.length} products`);

    // Step 4: Keep admin account (already exists)
    const adminCount = await Admin.countDocuments();
    console.log(`   ✅ Admin account exists: ${adminCount} admin(s)`);

    console.log('\n🎉 Cosmetic data seeded successfully!');
    console.log('\n📊 Summary:');
    console.log(`   - Categories: ${insertedCategories.length}`);
    console.log(`   - Products: ${insertedProducts.length}`);
    console.log(`   - Admin accounts: ${adminCount}`);
    console.log('\n💡 Next steps:');
    console.log('   1. Add more products through admin panel');
    console.log('   2. Add banners through admin panel');
    console.log('   3. Configure content settings');
    console.log('   4. Test the website');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    process.exit(1);
  }
}

seedDatabase();
