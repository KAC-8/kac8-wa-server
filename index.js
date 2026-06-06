const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const qrcodeImage = require('qrcode'); // 🟢 المكتبة الجديدة للصور
require('dotenv').config();

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || 'kac8_super_secret_key_2026';
const PORT = process.env.PORT || 3001;

let latestQR = ""; // 🟢 متغير لحفظ الباركود

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

// 🟢 إعداد عميل الواتساب
const client = new Client({
    authStrategy: new LocalAuth(), 
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    }
});

// 📸 توليد الباركود
client.on('qr', (qr) => {
    latestQR = qr; // حفظ الباركود الجديد
    console.log('\n=========================================');
    console.log('📱 تم توليد باركود جديد! افتح الرابط التالي لمسحه كصورة:');
    console.log(`🌐 ${process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT)}/qr`);
    console.log('=========================================\n');
});

// ✅ تأكيد الاتصال
client.on('ready', () => {
    latestQR = ""; // تفريغ الباركود بعد الاتصال
    console.log('🟢 المدفعية جاهزة! الواتساب متصل بنجاح.');
});

client.initialize();

// 🖼️ مسار عرض الباركود كصورة في المتصفح (الخطة السرية)
app.get('/qr', async (req, res) => {
    if (!latestQR) {
        return res.send(`
            <div style="display:flex; justify-content:center; align-items:center; height:100vh; background-color:#080808; color:#2e6417; font-family:sans-serif; text-align:center;">
                <h2>🟢 المدفعية متصلة مسبقاً، أو السيرفر لا يزال يجهز الباركود (انتظر ثواني وحدث الصفحة).</h2>
            </div>
        `);
    }
    try {
        const qrImageUrl = await qrcodeImage.toDataURL(latestQR);
        res.send(`
            <div style="display:flex; justify-content:center; align-items:center; height:100vh; flex-direction:column; background-color:#080808; color:#2e6417; font-family:sans-serif;">
                <h1>📱 امسح الباركود لربط متجر KAC8</h1>
                <img src="${qrImageUrl}" alt="QR Code" style="border: 15px solid white; border-radius: 10px; width: 300px; height: 300px;" />
                <p style="margin-top: 20px;">قم بتحديث الصفحة إذا تأخرت في مسحه (يتغير كل دقيقة).</p>
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

// مسار النبض
app.get('/ping', (req, res) => {
    res.status(200).send('I am awake, Emperor!');
});

// سكريبت الهاكرز
const keepAwake = () => {
    const min = 5 * 60 * 1000;
    const max = 14 * 60 * 1000;
    const randomTime = Math.floor(Math.random() * (max - min + 1)) + min;
    setTimeout(() => {
        const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        fetch(`${url}/ping`)
            .then(() => console.log(`[Keep-Alive ⚔️] ضربنا السيرفر عشان ما ينام! الضربة القادمة بعد ${Math.round(randomTime/60000)} دقايق.`))
            .catch(err => console.error('[Keep-Alive ❌] فشل النبض:', err.message));
        keepAwake();
    }, randomTime);
};
keepAwake();

app.listen(PORT, () => {
    console.log(`🚀 سيرفر الإشعارات شغال وينتظر الأوامر على البورت ${PORT}`);
});