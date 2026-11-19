const mongoose = require('mongoose');
const dns = require('node:dns');
require('dotenv').config();

const seedBanners = async () => {
    try {
        // Set DNS servers to resolve MongoDB SRV records
        const dnsServers = String(process.env.DNS_SERVERS || '8.8.8.8,8.8.4.4')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);

        if (dnsServers.length) {
            dns.setServers(dnsServers);
            console.log('✅ DNS servers set:', dnsServers.join(', '));
        }

        console.log('✅ Banner seed script disabled - add real banners through admin panel');
        console.log('   Login to admin panel: /login');
        console.log('   Admin credentials: admin@gmail.com / admin@1234');
        console.log('   Add banners in Admin Dashboard > Banners section');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
};

seedBanners();
