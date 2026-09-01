require('dotenv').config();

const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');

// =====================================================
// الإعدادات
// =====================================================
const app = express();
const PORT = Number(process.env.PORT || 3000);
const TARGET_GROUP_NAME = (process.env.TARGET_GROUP_NAME || '').trim();
const TARGET_GROUP_JID = (process.env.TARGET_GROUP_JID || '').trim();

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

let botState = {
  whatsapp: 'starting',
  lastMessageAt: null,
  lastSavedAt: null,
  lastError: null,
  matchedGroup: null
};

const groupNameCache = new Map();

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
      await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        botState.whatsapp = 'waiting_qr';
        console.log('📱 ظهر QR جديد — امسحه من WhatsApp > الأجهزة المرتبطة');
      }

      if (connection === 'open') {
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
// Health / Status — يفيد بفحص Render
// =====================================================
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'whatsapp-supabase-bot',
    whatsapp: botState.whatsapp,
    targetGroup: TARGET_GROUP_NAME || TARGET_GROUP_JID,
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
