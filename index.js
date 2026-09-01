require('dotenv').config();

const express = require('express');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');

// =====================================================
// الإعدادات
// =====================================================
const app = express();
const PORT = Number(process.env.PORT || 3000);
const TARGET_GROUP_NAME = (process.env.TARGET_GROUP_NAME || '').trim();
const TARGET_GROUP_JID = (process.env.TARGET_GROUP_JID || '').trim();
const AUTH_DIR = (process.env.AUTH_DIR || 'auth_info_baileys').trim();

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseKey = (process.env.SUPABASE_KEY || '').trim();

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL أو SUPABASE_KEY غير موجود في Environment');
  process.exit(1);
}

if (!TARGET_GROUP_NAME && !TARGET_GROUP_JID) {
  console.error('❌ لازم تضيف TARGET_GROUP_NAME أو TARGET_GROUP_JID');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});

app.use(express.json({ limit: '1mb' }));

let sock = null;
let connecting = false;
let reconnectTimer = null;
let latestQr = null;

let botState = {
  whatsapp: 'starting',
  lastMessageAt: null,
  lastSavedAt: null,
  lastError: null,
  matchedGroup: null
};

const groupNameCache = new Map();

// جلسة Baileys يجب أن تكون على مسار دائم في الاستضافة.
// على Render مع Persistent Disk استخدم مثلاً AUTH_DIR=/var/data/auth_info_baileys
try {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
} catch (error) {
  console.error('❌ تعذر إنشاء مجلد جلسة واتساب:', error?.message || error);
  process.exit(1);
}

// =====================================================
// أدوات مساعدة
// =====================================================
function normalizeArabic(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '') // الحركات
    .replace(/\u0640/g, '') // التطويل
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');
}

function unwrapMessageContent(content) {
  if (!content) return null;

  if (content.imageMessage) {
    return content.imageMessage;
  }

  if (content.ephemeralMessage?.message) {
    return unwrapMessageContent(content.ephemeralMessage.message);
  }

  if (content.viewOnceMessage?.message) {
    return unwrapMessageContent(content.viewOnceMessage.message);
  }

  if (content.viewOnceMessageV2?.message) {
    return unwrapMessageContent(content.viewOnceMessageV2.message);
  }

  if (content.viewOnceMessageV2Extension?.message) {
    return unwrapMessageContent(content.viewOnceMessageV2Extension.message);
  }

  if (content.documentWithCaptionMessage?.message) {
    return unwrapMessageContent(content.documentWithCaptionMessage.message);
  }

  return null;
}

function extensionFromMime(mimetype) {
  const mime = String(mimetype || '').toLowerCase();
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  return 'jpg';
}

function messageReceivedAt(message) {
  try {
    const raw = message?.messageTimestamp;
    const seconds = typeof raw === 'number'
      ? raw
      : Number(raw?.low ?? raw ?? 0);

    if (Number.isFinite(seconds) && seconds > 0) {
      return new Date(seconds * 1000).toISOString();
    }
  } catch (_) {}

  return new Date().toISOString();
}

function getDisconnectCode(lastDisconnect) {
  const error = lastDisconnect?.error;
  return (
    error?.output?.statusCode ??
    error?.data?.statusCode ??
    error?.statusCode ??
    null
  );
}

async function getGroupName(jid) {
  if (groupNameCache.has(jid)) {
    return groupNameCache.get(jid);
  }

  try {
    const metadata = await sock.groupMetadata(jid);
    const subject = String(metadata?.subject || '').trim();
    groupNameCache.set(jid, subject);
    return subject;
  } catch (error) {
    console.error('❌ تعذر قراءة اسم الكروب:', error?.message || error);
    return '';
  }
}

async function isTargetGroup(message) {
  const remoteJid = String(message?.key?.remoteJid || '');

  // لا نقبل صور الخاص نهائياً
  if (!remoteJid.endsWith('@g.us')) {
    return { ok: false, groupName: '' };
  }

  if (TARGET_GROUP_JID) {
    return {
      ok: remoteJid === TARGET_GROUP_JID,
      groupName: remoteJid === TARGET_GROUP_JID ? TARGET_GROUP_NAME : ''
    };
  }

  const groupName = await getGroupName(remoteJid);

  const ok =
    normalizeArabic(groupName) === normalizeArabic(TARGET_GROUP_NAME);

  return { ok, groupName };
}

// =====================================================
// رفع الصورة + إضافة سجل للشاشة
// =====================================================
async function saveImageToSupabase({
  buffer,
  mimetype,
  messageId,
  groupName,
  receivedAt
}) {
  let uploadedFileName = null;

  try {
    if (!messageId) {
      throw new Error('WhatsApp message id مفقود');
    }

    const ext = extensionFromMime(mimetype);

    // اسم ثابت حسب Message ID حتى إعادة نفس الحدث لا تنشئ صورة ثانية.
    uploadedFileName = `whatsapp-${messageId}.${ext}`;

    const { error: storageError } = await supabase.storage
      .from('incoming-approvals')
      .upload(uploadedFileName, buffer, {
        contentType: mimetype || 'image/jpeg',
        cacheControl: '3600',
        upsert: false
      });

    if (storageError) {
      // إذا سبق رفع نفس Message ID نعتبره حدثاً مكرراً ولا نكرر السجل.
      const msg = String(storageError.message || '').toLowerCase();
      if (
        msg.includes('already exists') ||
        msg.includes('duplicate') ||
        msg.includes('resource already exists')
      ) {
        console.log(`ℹ️ الصورة ${messageId} موجودة مسبقاً — تجاهل تكرار الحدث`);
        return { duplicate: true, publicUrl: null };
      }
      throw storageError;
    }

    const { data: publicUrlData } = supabase.storage
      .from('incoming-approvals')
      .getPublicUrl(uploadedFileName);

    const publicUrl = publicUrlData?.publicUrl;

    if (!publicUrl) {
      throw new Error('تعذر إنشاء رابط الصورة');
    }

    // مهم جداً:
    // اسم العمود الصحيح في قاعدة البيانات هو whatsapp_message_id
    // وليس message_id.
    const { error: dbError } = await supabase
      .from('incoming_approvals')
      .insert({
        image_url: publicUrl,
        source_group: groupName || TARGET_GROUP_NAME,
        whatsapp_message_id: messageId,
        received_at: receivedAt,
        is_read: false,
        status: 'received',
        document_number: null,
        list_id: null,
        passport_company_id: null,
        company_name: null,
        company_phone: null,
        company_email: null,
        match_status: 'pending',
        ocr_candidate: null,
        ocr_error: null,
        sent_via: null,
        sent_at: null,
        created_at: new Date().toISOString()
      });

    if (dbError) {
      // إذا فشل إدخال السجل لا نخلي صورة يتيمة في Storage.
      try {
        await supabase.storage
          .from('incoming-approvals')
          .remove([uploadedFileName]);
      } catch (_) {}

      throw dbError;
    }

    botState.lastSavedAt = new Date().toISOString();
    botState.lastError = null;

    return { duplicate: false, publicUrl };
  } catch (error) {
    const message = error?.message || String(error);
    botState.lastError = message;

    console.error('❌ خطأ في حفظ صورة الموافقة:', message);
    if (error?.details) console.error('details:', error.details);
    if (error?.hint) console.error('hint:', error.hint);
    if (error?.code) console.error('code:', error.code);

    return null;
  }
}

// =====================================================
// معالجة صورة واتساب
// =====================================================
async function processIncomingMessage(message) {
  if (!message?.message) return;

  const imageMessage = unwrapMessageContent(message.message);
  if (!imageMessage) return;

  const { ok, groupName } = await isTargetGroup(message);

  if (!ok) {
    if (String(message?.key?.remoteJid || '').endsWith('@g.us')) {
      console.log(
        `⏭️ تجاهل صورة من كروب آخر: ${groupName || message.key.remoteJid}`
      );
    }
    return;
  }

  const messageId = String(message?.key?.id || '').trim();
  const receivedAt = messageReceivedAt(message);
  const mimetype = imageMessage.mimetype || 'image/jpeg';

  botState.lastMessageAt = new Date().toISOString();
  botState.matchedGroup = groupName || TARGET_GROUP_NAME;

  console.log('--------------------------------------');
  console.log('📩 وصلت صورة من الكروب المطلوب');
  console.log('👥 الكروب:', groupName || TARGET_GROUP_NAME);
  console.log('🆔 Message ID:', messageId);

  try {
    const buffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        reuploadRequest: sock.updateMediaMessage
      }
    );

    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('فشل تحميل الصورة من واتساب');
    }

    console.log('📦 حجم الصورة:', buffer.length, 'bytes');

    const saved = await saveImageToSupabase({
      buffer,
      mimetype,
      messageId,
      groupName,
      receivedAt
    });

    if (saved?.duplicate) {
      return;
    }

    if (saved?.publicUrl) {
      console.log('✅ تم رفع الصورة وإضافتها إلى incoming_approvals');
      console.log('📸', saved.publicUrl);
    }
  } catch (error) {
    const messageText = error?.message || String(error);
    botState.lastError = messageText;
    console.error('❌ خطأ أثناء معالجة صورة واتساب:', messageText);
  }
}

// =====================================================
// الاتصال بواتساب + إعادة الاتصال
// =====================================================
async function connectToWhatsApp() {
  if (connecting) return;
  connecting = true;

  try {
    botState.whatsapp = 'connecting';

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQr = qr;
        botState.whatsapp = 'waiting_qr';
        console.log('📱 ظهر QR جديد — افتح /qr من رابط السيرفر وامسحه من واتساب');
      }

      if (connection === 'open') {
        latestQr = null;
        botState.whatsapp = 'connected';
        botState.lastError = null;
        groupNameCache.clear();

        console.log('======================================');
        console.log('✅ تم الاتصال بواتساب');
        console.log('👥 الكروب المطلوب:', TARGET_GROUP_NAME || TARGET_GROUP_JID);
        console.log('☁️ Supabase جاهز');
        console.log('======================================');
      }

      if (connection === 'close') {
        const code = getDisconnectCode(lastDisconnect);
        const loggedOut = code === DisconnectReason.loggedOut;

        botState.whatsapp = loggedOut ? 'logged_out' : 'disconnected';
        botState.lastError =
          lastDisconnect?.error?.message ||
          `WhatsApp disconnected${code ? ` (${code})` : ''}`;

        console.error(
          `❌ انقطع اتصال واتساب${code ? ` — code: ${code}` : ''}`
        );

        if (loggedOut) {
          console.error(
            '⚠️ الجلسة مسجلة خروج. امسح/بدّل auth_info_baileys ثم اربط QR من جديد.'
          );
          return;
        }

        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          connecting = false;
          connectToWhatsApp().catch(console.error);
        }, 5000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // notify للرسائل الجديدة. append قد يظهر ببعض مزامنة الأجهزة،
      // لذلك نتجاهل غير notify حتى لا نعيد صور قديمة.
      if (type !== 'notify') return;

      for (const message of messages || []) {
        await processIncomingMessage(message);
      }
    });
  } catch (error) {
    const msg = error?.message || String(error);
    botState.whatsapp = 'error';
    botState.lastError = msg;
    console.error('❌ فشل تشغيل اتصال واتساب:', msg);

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connecting = false;
      connectToWhatsApp().catch(console.error);
    }, 5000);
  } finally {
    // عند نجاح إنشاء socket نسمح لـ connection.update بإدارة إعادة الاتصال.
    connecting = false;
  }
}


// =====================================================
// ربط واتساب: QR + Pairing Code
// =====================================================

// افتح: https://YOUR-SERVICE.onrender.com/qr
app.get('/qr', async (_req, res) => {
  try {
    if (botState.whatsapp === 'connected') {
      return res.status(200).send(`
        <html lang="ar" dir="rtl">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>WhatsApp Connected</title>
        </head>
        <body style="font-family:Arial;text-align:center;padding:30px">
          <h2>✅ واتساب مرتبط بالفعل</h2>
          <p>الحالة: connected</p>
        </body>
        </html>
      `);
    }

    if (!latestQr) {
      return res.status(200).send(`
        <html lang="ar" dir="rtl">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <meta http-equiv="refresh" content="4">
          <title>WhatsApp QR</title>
        </head>
        <body style="font-family:Arial;text-align:center;padding:30px">
          <h2>⏳ بانتظار QR من واتساب...</h2>
          <p>الحالة الحالية: ${botState.whatsapp}</p>
          <p>الصفحة تتحدث تلقائياً كل 4 ثواني.</p>
        </body>
        </html>
      `);
    }

    const dataUrl = await QRCode.toDataURL(latestQr, {
      width: 360,
      margin: 2
    });

    return res.status(200).send(`
      <html lang="ar" dir="rtl">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="refresh" content="20">
        <title>WhatsApp QR</title>
      </head>
      <body style="font-family:Arial;text-align:center;padding:20px">
        <h2>📱 امسح QR من واتساب</h2>
        <p>واتساب ← الأجهزة المرتبطة ← ربط جهاز</p>
        <img src="${dataUrl}" alt="WhatsApp QR" style="max-width:95%;width:360px">
        <p>إذا انتهت صلاحية الرمز، الصفحة تتحدث تلقائياً.</p>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('❌ خطأ إنشاء QR:', error?.message || error);
    return res.status(500).send('تعذر إنشاء QR');
  }
});

// افتح مثلاً:
// https://YOUR-SERVICE.onrender.com/pair?phone=9647XXXXXXXXX
// الرقم: مفتاح الدولة + الرقم، أرقام فقط، بدون + وبدون الصفر الأول.
app.get('/pair', async (req, res) => {
  try {
    if (!sock) {
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp socket غير جاهز بعد. انتظر ثواني وأعد المحاولة.'
      });
    }

    if (botState.whatsapp === 'connected') {
      return res.status(200).json({
        ok: true,
        connected: true,
        message: 'واتساب مرتبط بالفعل'
      });
    }

    const phone = String(req.query.phone || '').replace(/\D/g, '');

    if (!phone || phone.length < 8 || phone.length > 15) {
      return res.status(400).json({
        ok: false,
        error: 'اكتب الرقم بصيغة دولية أرقام فقط. للعراق مثال: 9647XXXXXXXXX'
      });
    }

    const code = await sock.requestPairingCode(phone);
    const formatted = String(code || '').match(/.{1,4}/g)?.join('-') || code;

    console.log('🔗 تم إنشاء Pairing Code');

    return res.status(200).send(`
      <html lang="ar" dir="rtl">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>WhatsApp Pairing Code</title>
      </head>
      <body style="font-family:Arial;text-align:center;padding:30px">
        <h2>🔗 رمز ربط واتساب</h2>
        <div style="font-size:36px;font-weight:bold;letter-spacing:4px;margin:25px">
          ${formatted}
        </div>
        <p>في واتساب: الأجهزة المرتبطة ← ربط جهاز ← الربط باستخدام رقم الهاتف.</p>
        <p>إذا انتهت صلاحية الرمز، افتح الرابط مرة ثانية للحصول على رمز جديد.</p>
      </body>
      </html>
    `);
  } catch (error) {
    const msg = error?.message || String(error);
    console.error('❌ خطأ Pairing Code:', msg);
    return res.status(500).json({ ok: false, error: msg });
  }
});

// =====================================================
// Health / Status — يفيد بفحص Render
// =====================================================
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'whatsapp-supabase-bot',
    whatsapp: botState.whatsapp,
    targetGroup: TARGET_GROUP_NAME || TARGET_GROUP_JID,
    authStorage: AUTH_DIR === 'auth_info_baileys' ? 'local_ephemeral_or_project' : 'custom_path',
    matchedGroup: botState.matchedGroup,
    lastMessageAt: botState.lastMessageAt,
    lastSavedAt: botState.lastSavedAt,
    lastError: botState.lastError
  });
});

app.get('/health', (_req, res) => {
  const healthy =
    botState.whatsapp === 'connected' ||
    botState.whatsapp === 'connecting' ||
    botState.whatsapp === 'waiting_qr';

  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    whatsapp: botState.whatsapp,
    targetGroup: TARGET_GROUP_NAME || TARGET_GROUP_JID,
    authStorage: AUTH_DIR === 'auth_info_baileys' ? 'local_ephemeral_or_project' : 'custom_path',
    lastMessageAt: botState.lastMessageAt,
    lastSavedAt: botState.lastSavedAt,
    lastError: botState.lastError
  });
});

// =====================================================
// تشغيل السيرفر
// =====================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 API Server يعمل');
  console.log(`🌐 PORT: ${PORT}`);
  console.log('👥 الكروب المطلوب:', TARGET_GROUP_NAME || TARGET_GROUP_JID);
  console.log('☁️ Supabase client جاهز');
  console.log('======================================\n');

  connectToWhatsApp().catch((error) => {
    console.error('❌ connectToWhatsApp:', error);
  });
});
