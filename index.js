require('dotenv').config();
const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    downloadMediaMessage 
} = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');

// =====================================================
// إعدادات التطبيق والمتغيرات
// =====================================================
const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_GROUP_NAME = process.env.TARGET_GROUP_NAME || 'My Group';

// إعداد Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

let latestImage = null;
let sock = null;

app.use(express.json());

// =====================================================
// دالة رفع الصور إلى Supabase
// =====================================================
async function saveImageToSupabase(buffer, mimetype, messageId) {
    try {
        const fileName = `${Date.now()}_${messageId}.jpg`;
        
        // 1. رفع الصورة إلى Storage Bucket
        const { data: storageData, error: storageError } = await supabase.storage
            .from('incoming-approvals')
            .upload(fileName, buffer, { contentType: mimetype });

        if (storageError) throw storageError;

        // الحصول على رابط الصورة العام
        const { data: publicUrlData } = supabase.storage
            .from('incoming-approvals')
            .getPublicUrl(fileName);

        const publicUrl = publicUrlData.publicUrl;

        // 2. حفظ بيانات الصورة في جدول القاعده
        const { data: dbData, error: dbError } = await supabase
            .from('incoming_approvals')
            .insert([
                { 
                    message_id: messageId, 
                    image_url: publicUrl, 
                    created_at: new Date() 
                }
            ]);

        if (dbError) throw dbError;

        return publicUrl;
    } catch (error) {
        console.error('❌ خطأ في رفع الصورة إلى Supabase:', error.message);
        return null;
    }
}

// =====================================================
// دالة الاتصال بالواتساب
// =====================================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const message of messages) {
            if (!message.message) continue;

            const imageMessage = message.message.imageMessage;

            if (imageMessage) {
                try {
                    // تحميل ملف الميديا
                    const buffer = await downloadMediaMessage(
                        message,
                        'buffer',
                        {},
                        {
                            logger: console,
                            reuploadRequest: sock.updateMediaMessage
                        }
                    );

                    // فشل التحميل
                    if (!buffer) {
                        console.log('❌ فشل تحميل الصورة');
                        continue;
                    }

                    // حفظ محلي موقت بالذاكرة
                    latestImage = {
                        buffer: buffer,
                        mimetype: imageMessage.mimetype || 'image/jpeg', // تصحيح أداة ||
                        timestamp: Date.now(),
                        messageId: message.key.id
                    };

                    console.log('✅ تم استلام الصورة بنجاح');
                    console.log('📦 حجم الصورة:', buffer.length, 'bytes');

                    // رفع إلى Supabase
                    const savedUrl = await saveImageToSupabase(
                        buffer,
                        imageMessage.mimetype || 'image/jpeg', // تصحيح أداة ||
                        message.key.id
                    );

                    if (savedUrl) {
                        console.log('======================================');
                        console.log('🎉 تمت العملية بنجاح!');
                        console.log('📸 الصورة محفوظة في Supabase:', savedUrl);
                        console.log('📦 Bucket: incoming-approvals');
                        console.log('🗄 Table: incoming_approvals');
                        console.log('======================================\n');
                    }

                } catch (error) {
                    console.error('❌ خطأ أثناء معالجة الصورة:');
                    console.error(error);
                }
            }
        }
    });
}

// =====================================================
// تشغيل API Server
// =====================================================
app.listen(
    PORT,
    '0.0.0.0',
    () => {
        console.log('\n🚀 API Server يعمل');
        console.log(`🌐 http://localhost:${PORT}`); // تصحيح علامات Backticks
        console.log('👥 الكروب:', TARGET_GROUP_NAME);
        console.log('☁️ Supabase جاهز');
        console.log('======================================\n');

        connectToWhatsApp();
    }
);