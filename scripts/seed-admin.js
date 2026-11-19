const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const dns = require('node:dns');
require('dotenv').config();

const { AdminModel } = require('../src/models/admin');

// Set DNS servers to resolve MongoDB SRV records
const dnsServers = String(process.env.DNS_SERVERS || '8.8.8.8,8.8.4.4')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (dnsServers.length) {
  dns.setServers(dnsServers);
  console.log('✅ DNS servers set:', dnsServers.join(', '));
}

const seedAdmin = async () => {
    try {
        // Connect to MongoDB
        const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/glowalchemy';
        await mongoose.connect(mongoUri);
        console.log('✅ Connected to MongoDB');

        // Check if admin already exists
        const existingAdmin = await AdminModel.findOne({ email: 'admin@gmail.com' });
        
        if (existingAdmin) {
            console.log('⚠️  Admin account already exists with email: admin@gmail.com');
            console.log('   Skipping admin creation.');
            process.exit(0);
        }

        // Create admin account
        const adminData = {
            firstName: 'Admin',
            lastName: 'User',
            email: 'admin@gmail.com',
            password: 'admin@1234',
            role: 'admin',
            active: true,
            emailVerified: true
        };

        const admin = new AdminModel(adminData);
        await admin.save();

        console.log('✅ Admin account created successfully!');
        console.log('   Email: admin@gmail.com');
        console.log('   Password: admin@1234');
        console.log('   Role: admin');
        console.log('');
        console.log('⚠️  IMPORTANT: Change the password after first login!');

        await mongoose.connection.close();
        console.log('✅ Database connection closed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error seeding admin:', error);
        process.exit(1);
    }
};

seedAdmin();
