// ==========================================
// KAC8 WhatsApp Notification Engine (Anti-Ban Edition)
// ==========================================

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeImage = require('qrcode');
require('dotenv').config();

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || 'kac8_super_secret_key_2026';
const PORT = process.env.PORT || 3001;

let latestQR = ""; 

// 🛡️ جدار حماية بسيط
const authenticate = (req, res, next) => {
    const token = req.headers['authorization'];
    if (token === `Bearer ${API_KEY}`) {
        next(); 
    } else {
        console.warn('⚠️ محاولة وصول غير مصرح بها!');
        res.status(401).json({ error: 'Unauthorized: خييير وش تبي؟' });
    }
};

// 🟢 إعداد عميل الواتساب (مضاف إليه كاسر حظر الإصدارات)
const client = new Client({
    authStrategy: new LocalAuth(), 
    // 🔥 هذا السطر السحري يجبر المكتبة تستخدم نسخة حديثة لتجاوز خطأ "يتعذر ربط أجهزة جديدة"
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
        headless: true, 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', 
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--js-flags="--max-old-space-size=1024"' 
        ] 
    }
});

// 📸 توليد الباركود
client.on('qr', (qr) => {
    latestQR = qr;
    console.log('\n=========================================');
    console.log('📱 تم توليد باركود جديد! افتح الرابط التالي لمسحه كصورة:');
    console.log(`🌐 https://wa.kac8.codes/qr`);
    console.log('=========================================\n');
});

// ✅ تأكيد الاتصال
client.on('ready', () => {
    latestQR = ""; 
    console.log('🟢 المدفعية جاهزة! الواتساب متصل بنجاح.');
});

// تشغيل المتصفح وبدء الجلسة
client.initialize();

// 🖼️ مسار عرض الباركود كصورة (بثيم KAC8)
app.get('/qr', async (req, res) => {
    if (!latestQR) {
        return res.send(`
            <div style="display:flex; justify-content:center; align-items:center; height:100vh; background-color:#080808; color:#2e6417; font-family:sans-serif; text-align:center;">
                <h2>🟢 المدفعية متصلة مسبقاً، أو السيرفر يجهز الباركود (انتظر ثواني وحدث).</h2>
            </div>
        `);
    }
    try {
        const qrImageUrl = await qrcodeImage.toDataURL(latestQR);
        res.send(`
            <div style="display:flex; justify-content:center; align-items:center; height:100vh; flex-direction:column; background-color:#080808; color:#2e6417; font-family:sans-serif;">
                <h1>📱 امسح الباركود لربط متجر KAC8</h1>
                <img src="${qrImageUrl}" alt="QR Code" style="border: 15px solid white; border-radius: 10px; width: 300px; height: 300px;" />
                <p style="margin-top: 20px; font-weight: bold;">تنبيه: الباركود يتغير كل 20 ثانية. حدث الصفحة وامسح فوراً!</p>
            </div>
        `);
    } catch (err) {
        res.status(500).send('❌ خطأ في توليد الصورة');
    }
});

// 🚀 مسار إرسال الرسائل
app.post('/send', authenticate, async (req, res) => {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ error: 'Phone and message are required' });
    }

    try {
        let formattedPhone = phone.replace(/[^0-9]/g, '');
        
        if (formattedPhone.startsWith('00')) {
            formattedPhone = formattedPhone.substring(2); 
        } else if (formattedPhone.startsWith('05') && formattedPhone.length === 10) {
            formattedPhone = '966' + formattedPhone.substring(1); 
        } else if (formattedPhone.startsWith('5') && formattedPhone.length === 9) {
            formattedPhone = '966' + formattedPhone; 
        }

        const chatId = `${formattedPhone}@c.us`; 

        await client.sendMessage(chatId, message);
        console.log(`📩 تم إرسال رسالة إلى: ${formattedPhone}`);
        res.status(200).json({ success: true, msg: 'Message sent successfully!' });

    } catch (error) {
        console.error('❌ خطأ في الإرسال:', error.message);
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 سيرفر الإشعارات شغال وينتظر الأوامر على البورت ${PORT}`);
});