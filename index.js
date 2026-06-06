const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
require('dotenv').config();

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || 'kac8_super_secret_key_2026';
const PORT = process.env.PORT || 3001;

// 🛡️ جدار حماية بسيط (Middleware)
const authenticate = (req, res, next) => {
    const token = req.headers['authorization'];
    if (token === `Bearer ${API_KEY}`) {
        next();
    } else {
        console.warn('⚠️ محاولة وصول غير مصرح بها!');
        res.status(401).json({ error: 'Unauthorized: خييير وش تبي؟' });
    }
};

// 🟢 إعداد عميل الواتساب
const client = new Client({
    authStrategy: new LocalAuth(), // عشان يحفظ الجلسة وما يطلب باركود كل مرة
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // مهم جداً عشان يشتغل على السيرفرات السحابية
    }
});

// 📸 توليد الباركود
client.on('qr', (qr) => {
    console.log('\n=========================================');
    console.log('📱 امسح الباركود هذا بجوال المتجر (الأجهزة المرتبطة):');
    console.log('=========================================\n');
    qrcode.generate(qr, { small: true });
});

// ✅ تأكيد الاتصال
client.on('ready', () => {
    console.log('🟢 المدفعية جاهزة! الواتساب متصل بنجاح.');
});

client.initialize();

// 🚀 مسار إرسال الرسائل (الـ API اللي بيكلمه متجرك)
app.post('/send', authenticate, async (req, res) => {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ error: 'Phone and message are required' });
    }

    try {
        // تنظيف الرقم وتجهيزه للصيغة الدولية للواتساب
        let formattedPhone = phone.replace(/[^0-9]/g, '');
        
        // إذا كان الرقم سعودي ويبدأ بـ 05، نحوله إلى 9665
        if (formattedPhone.startsWith('05')) {
            formattedPhone = '966' + formattedPhone.substring(1);
        }
        
        const chatId = `${formattedPhone}@c.us`;

        await client.sendMessage(chatId, message);
        console.log(`📩 تم إرسال رسالة إلى: ${formattedPhone}`);
        res.status(200).json({ success: true, msg: 'Message sent successfully!' });
    } catch (error) {
        console.error('❌ خطأ في الإرسال:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 سيرفر الإشعارات شغال وينتظر الأوامر على البورت ${PORT}`);
});