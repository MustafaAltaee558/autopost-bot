require('dotenv').config();
const express = require('express');
const path = require('path');
const dbService = require('./services/dbService');
const { createBot } = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234560';

// Express Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cookie Parser Middleware
app.use((req, res, next) => {
  const cookieHeader = req.headers.cookie;
  req.cookies = {};
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      req.cookies[parts[0].trim()] = decodeURIComponent(parts[1] ? parts[1].trim() : '');
    });
  }
  next();
});

// Admin Auth Middleware
function checkAdminAuth(req, res, next) {
  if (req.cookies && req.cookies.admin_session === ADMIN_PASSWORD) {
    return next();
  }
  if (req.xhr || req.headers.accept?.includes('json')) {
    return res.status(401).json({ success: false, error: 'غير مصرح للوصول' });
  }
  return res.send(renderLoginPage());
}

// CORS Header Middleware for /auth routes
app.use('/auth', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Helper to get base server URL
function getBaseServerUrl(req) {
  let url = (process.env.SERVER_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL.replace(/^https?:\/\//, '')}` : '')).trim();
  if (!url) {
    const host = req.get('host');
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    url = `${protocol}://${host}`;
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }
  return url.replace(/\/$/, '');
}

// -------------------------------------------------------------
// Facebook / Meta OAuth 2.0 Integration Routes
// -------------------------------------------------------------
app.get('/auth/facebook', (req, res) => {
  const { chatId } = req.query;
  if (!chatId) {
    return res.status(400).send('❌ معرف المستخدم (chatId) غير متوفر.');
  }

  const appId = process.env.FACEBOOK_APP_ID;
  if (!appId) {
    return res.status(500).send('❌ FACEBOOK_APP_ID غير مضبوط في ملف .env');
  }

  const serverUrl = getBaseServerUrl(req);
  const redirectUri = `${serverUrl}/auth/facebook/callback`;
  const scope = 'email,public_profile,pages_show_list,pages_manage_posts';

  const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${chatId}&scope=${scope}`;

  return res.redirect(authUrl);
});

app.get('/auth/instagram', (req, res) => {
  const { chatId } = req.query;
  if (!chatId) {
    return res.status(400).send('❌ معرف المستخدم (chatId) غير متوفر.');
  }

  const appId = process.env.FACEBOOK_APP_ID;
  if (!appId) {
    return res.status(500).send('❌ FACEBOOK_APP_ID غير مضبوط في ملف .env');
  }

  const serverUrl = getBaseServerUrl(req);
  const redirectUri = `${serverUrl}/auth/instagram/callback`;
  const scope = 'email,public_profile,pages_show_list,pages_manage_posts,instagram_basic,instagram_content_publish';

  const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${chatId}&scope=${scope}`;

  return res.redirect(authUrl);
});

app.get(['/auth/facebook/callback', '/auth/instagram/callback'], async (req, res) => {
  try {
    const { code, state: chatId, error, error_description } = req.query;

    if (error || !code) {
      console.error('❌ Meta OAuth Auth Error:', error_description || error || 'No authorization code');
      return res.send(renderOAuthResultPage(false, `إلغاء أو خطأ في التفويض: ${error_description || 'لم يتم استلام الكود'}`));
    }

    if (!chatId) {
      console.error('❌ State parameter missing or invalid:', chatId);
      return res.send(renderOAuthResultPage(false, 'معرف المستخدم (chatId) غير متوفر في الاستجابة.'));
    }

    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    const serverUrl = getBaseServerUrl(req);
    const redirectUri = `${serverUrl}${req.path}`;

    // 1. Exchange authorization code for Short-Lived Access Token
    const tokenUrl = `https://graph.facebook.com/v18.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      console.error('❌ Meta Token Exchange Error Details:', JSON.stringify(tokenData.error, null, 2));
      throw new Error(tokenData.error.message || 'فشل الحصول على Access Token');
    }

    const shortLivedToken = tokenData.access_token;

    // 2. Exchange for Long-Lived Token
    const longLivedUrl = `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`;
    const longLivedRes = await fetch(longLivedUrl);
    const longLivedData = await longLivedRes.json();

    if (longLivedData.error) {
      console.warn('⚠️ Meta Long-Lived Token Exchange Warning:', JSON.stringify(longLivedData.error, null, 2));
    }

    const userAccessToken = longLivedData.access_token || shortLivedToken;

    // 3. Fetch User's Facebook Pages & Instagram Accounts
    const pagesUrl = `https://graph.facebook.com/v18.0/me/accounts?access_token=${userAccessToken}`;
    const pagesRes = await fetch(pagesUrl);
    const pagesData = await pagesRes.json();

    if (pagesData.error) {
      console.error('❌ Meta Pages Fetch Error Details:', JSON.stringify(pagesData.error, null, 2));
      return res.send(renderOAuthResultPage(false, `خطأ في جلب الصفحات: ${pagesData.error.message}`));
    }

    if (!pagesData.data || pagesData.data.length === 0) {
      console.warn('⚠️ No Facebook/Instagram pages returned for user:', chatId);
      return res.send(renderOAuthResultPage(false, 'لم يتم العثور على صفحات فيسبوك أو إنستغرام تديرها بهذا الحساب.'));
    }

    const connectedPages = [];

    for (const page of pagesData.data) {
      // Save Facebook Page to Firestore / Local DB
      const fbAcc = {
        platform: 'facebook',
        pageId: page.id,
        pageName: page.name,
        accessToken: page.access_token,
      };
      dbService.saveConnectedAccount(chatId, fbAcc);
      connectedPages.push(page.name);

      // Check for attached Instagram Business Account
      try {
        const igCheckUrl = `https://graph.facebook.com/v18.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`;
        const igRes = await fetch(igCheckUrl);
        const igData = await igRes.json();

        if (igData.instagram_business_account && igData.instagram_business_account.id) {
          const igAcc = {
            platform: 'instagram',
            igAccountId: igData.instagram_business_account.id,
            pageId: page.id,
            pageName: `${page.name} (Instagram)`,
            accessToken: page.access_token,
          };
          dbService.saveConnectedAccount(chatId, igAcc);
          connectedPages.push(`${page.name} (Instagram)`);
        }
      } catch (igErr) {
        console.warn(`Could not check IG account for page ${page.id}:`, igErr.message);
      }
    }

    // Connect platforms in DB user
    dbService.connectPlatform(chatId, 'facebook');
    dbService.connectPlatform(chatId, 'instagram');

    // Send instant Telegram notification to the user
    if (botInstance && chatId) {
      try {
        await botInstance.telegram.sendMessage(chatId, "✅ تم ربط حسابك بنجاح! يمكنك الآن النشر تلقائياً.");
      } catch (tgErr) {
        console.error('❌ Error sending Telegram notification:', tgErr.message);
      }
    }

    // Return clean elegant HTML page
    return res.send(renderOAuthResultPage(true, "تم الربط بنجاح! يمكنك إغلاق هذه الصفحة والعودة للتليجرام."));
  } catch (err) {
    console.error('❌ Callback Handling Exception:', err);
    return res.send(renderOAuthResultPage(false, `حدث خطأ أثناء إكمال التفويض: ${err.message}`));
  }
});

// Admin Authentication Routes
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie', `admin_session=${encodeURIComponent(ADMIN_PASSWORD)}; Path=/; HttpOnly; Max-Age=86400`);
    return res.redirect('/admin');
  }
  return res.send(renderLoginPage('كلمة المرور غير صحيحة!'));
});

app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', `admin_session=; Path=/; HttpOnly; Max-Age=0`);
  return res.redirect('/admin');
});

// Admin Dashboard
app.get('/admin', checkAdminAuth, (req, res) => {
  const users = dbService.getAllUsers();
  res.send(renderDashboardPage(users));
});

// API: Quick Activation
app.post('/admin/api/quick-activate', checkAdminAuth, (req, res) => {
  const { userId, tier } = req.body;
  if (!userId) return res.status(400).json({ success: false, error: 'User ID is required' });

  const updatedUser = dbService.quickActivateUser(userId, tier || 'pro');
  if (!updatedUser) return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });

  return res.json({
    success: true,
    message: `تم تفعيل باقة ${tier.toUpperCase()} بنجاح وحفظ البيانات بـ Firestore!`,
    user: updatedUser,
  });
});

// API: Toggle Status
app.post('/admin/api/toggle-status', checkAdminAuth, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ success: false, error: 'User ID is required' });

  const updatedUser = dbService.toggleUserStatus(userId);
  if (!updatedUser) return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });

  return res.json({ success: true, message: `تم تغيير حالة المستخدم إلى ${updatedUser.status}`, user: updatedUser });
});

// API: Direct User Update
app.post('/admin/api/update-balance', checkAdminAuth, (req, res) => {
  const { userId, amount, subscription, status } = req.body;
  if (!userId) return res.status(400).json({ success: false, error: 'معرف العميل (User ID) مطلوب' });

  const user = dbService.getUser(userId);
  if (!user) return res.status(404).json({ success: false, error: 'معرف العميل غير موجود في النظام' });

  const updates = {};
  if (amount !== undefined && amount !== '') {
    updates.balance = parseInt(amount, 10);
  } else if (subscription) {
    // Auto populate default balance if amount is blank
    if (subscription === 'starter') updates.balance = 30;
    else if (subscription === 'pro') updates.balance = 150;
    else if (subscription === 'enterprise') updates.balance = 999999;
  }

  if (subscription) {
    updates.subscription = subscription;
  }
  if (status) {
    updates.status = status;
  }

  const updatedUser = dbService.updateUser(userId, updates);
  return res.json({ success: true, message: 'تم تحديث بيانات العميل وحفظها في Firestore بنجاح!', user: updatedUser });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send("AutoPost Server is Running on Vercel Successfully!");
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start Telegraf Bot & Register Webhook
let botInstance = null;
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN !== 'your_bot_token') {
  try {
    botInstance = createBot(process.env.TELEGRAM_BOT_TOKEN);

    // Register Webhook POST route middleware in Express for Telegram updates
    app.use(botInstance.webhookCallback('/bot-webhook'));

    let SERVER_URL = process.env.SERVER_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
    if (SERVER_URL && !SERVER_URL.startsWith('http://') && !SERVER_URL.startsWith('https://')) {
      SERVER_URL = `https://${SERVER_URL}`;
    }

    if (SERVER_URL) {
      const webhookUrl = `${SERVER_URL}/bot-webhook`;
      botInstance.telegram.setWebhook(webhookUrl)
        .then(() => console.log(`🤖 تم تسجيل Webhook بنجاح مع التليجرام: ${webhookUrl}`))
        .catch(err => console.warn('⚠️ خطأ أثناء ضبط Webhook:', err.message));
    }
  } catch (err) {
    console.error('❌ فشل تهيئة البوت:', err.message);
  }
}

// Start Server (Only for local execution, Vercel exports app as Serverless Function)
if (require.main === module || (!process.env.VERCEL && process.env.NODE_ENV !== 'production')) {
  app.listen(PORT, () => {
    console.log(`🚀 السيرفر يعمل الآن على المنفذ: http://localhost:${PORT}`);
    console.log(`🔑 لوحة تحكم الأدمن متاحة على: http://localhost:${PORT}/admin`);
  });
}

// -------------------------------------------------------------
// HTML Rendering Functions
// -------------------------------------------------------------
function renderOAuthLandingPage(authUrl, platformName) {
  const isIg = platformName === 'إنستغرام';
  const cleanUrl = authUrl.replace(/'/g, "\\'");
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ربط حساب ${platformName} - AutoPost</title>
  <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    body {
      background: #0f172a;
      color: #f8fafc;
      font-family: 'Tajawal', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      margin: 0;
    }
    .card {
      background: rgba(30, 41, 59, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 24px;
      padding: 36px 28px;
      text-align: center;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(12px);
    }
    .icon { font-size: 56px; margin-bottom: 16px; }
    h1 { color: #f8fafc; font-size: 22px; font-weight: 700; margin-bottom: 12px; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
    .badge {
      background: rgba(56, 189, 248, 0.1);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.2);
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      display: inline-block;
      margin-bottom: 20px;
    }
    .btn {
      display: block;
      width: 100%;
      background: ${isIg ? 'linear-gradient(135deg, #e1306c, #c13584, #833ab4)' : 'linear-gradient(135deg, #1877f2, #0056b3)'};
      color: #ffffff;
      padding: 16px 20px;
      border-radius: 14px;
      text-decoration: none;
      font-weight: 700;
      font-size: 16px;
      box-sizing: border-box;
      box-shadow: 0 10px 20px rgba(0, 0, 0, 0.3);
      transition: transform 0.2s, opacity 0.2s;
    }
    .btn:hover { transform: translateY(-2px); opacity: 0.95; }
    .footer-tip { margin-top: 20px; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${isIg ? '📸' : '📘'}</div>
    <div class="badge">🔒 آمن ومشفّر 100%</div>
    <h1>تفويض وربط حساب ${platformName}</h1>
    <p>لضمان حماية حسابك وتجاوز اختبار الآلي (reCAPTCHA)، اضغط الزر أدناه لمتابعة تسجيل الدخول عبر متصفحك الخارجي (Chrome / Safari):</p>
    <a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="btn">
      🚀 متابعة تسجيل الدخول على ${platformName}
    </a>
    <p class="footer-tip">نصيحة: يمكنك أيضاً الضغط على القائمة العلوية للتليجرام (⋮) واختيار "Open in Browser".</p>
  </div>
  <script>
    if (!navigator.userAgent.includes('Telegram')) {
      setTimeout(() => { window.location.href = '${cleanUrl}'; }, 300);
    }
  </script>
</body>
</html>`;
}

function renderOAuthResultPage(success, detailMessage = '', isIg = false) {
  const platformTitle = isIg ? 'إنستغرام' : 'فيسبوك';
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${success ? `تم ربط ${platformTitle} بنجاح` : 'خطأ في الربط'}</title>
  <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    body {
      background: #0f172a;
      color: #f8fafc;
      font-family: 'Tajawal', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      margin: 0;
    }
    .card {
      background: rgba(30, 41, 59, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      padding: 40px;
      text-align: center;
      max-width: 450px;
      width: 100%;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
    }
    .icon { font-size: 64px; margin-bottom: 20px; }
    h1 { color: ${success ? '#34d399' : '#fca5a5'}; font-size: 24px; margin-bottom: 12px; }
    p { color: #cbd5e1; font-size: 15px; line-height: 1.6; margin-bottom: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? (isIg ? '📸' : '🎉') : '⚠️'}</div>
    <h1>${success ? `تم ربط ${platformTitle} بنجاح!` : 'لم يكتمل الربط'}</h1>
    <p>${detailMessage}</p>
    <p style="font-size: 13px; color: #94a3b8">يمكنك إغلاق هذه الصفحة الآن والعودة لتطبيق البوت للنشر المباشر 🚀</p>
  </div>
</body>
</html>`;
}


function renderLoginPage(errorMessage = '') {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>تسجيل الدخول - AutoPost Admin</title>
  <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Tajawal', sans-serif; }
    body { background: #0f172a; color: #f8fafc; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .login-card { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; padding: 40px; width: 100%; max-width: 400px; }
    .login-header { text-align: center; margin-bottom: 30px; }
    .login-header h1 { font-size: 24px; color: #38bdf8; margin-bottom: 8px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; font-size: 14px; color: #cbd5e1; }
    input[type="password"] { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid #334155; background: #1e293b; color: #fff; outline: none; }
    button { width: 100%; padding: 14px; background: linear-gradient(135deg, #0284c7, #38bdf8); border: none; border-radius: 10px; color: #fff; font-size: 16px; font-weight: 700; cursor: pointer; }
    .error-msg { background: rgba(239, 68, 68, 0.2); border: 1px solid #ef4444; color: #fca5a5; padding: 10px; border-radius: 8px; margin-bottom: 20px; font-size: 14px; text-align: center; }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="login-header">
      <h1>🔐 AutoPost Admin</h1>
      <p>أدخل كلمة المرور للوصول للوحة التحكم</p>
    </div>
    ${errorMessage ? `<div class="error-msg">${errorMessage}</div>` : ''}
    <form action="/admin/login" method="POST">
      <div class="form-group">
        <label for="password">كلمة المرور</label>
        <input type="password" id="password" name="password" required autofocus placeholder="••••••••">
      </div>
      <button type="submit">دخول اللوحة</button>
    </form>
  </div>
</body>
</html>`;
}

function renderDashboardPage(users = []) {
  const totalUsers = users.length;
  const activeUsers = users.filter(u => u.status === 'active').length;
  const frozenUsers = users.filter(u => u.status === 'frozen').length;
  const totalBalance = users.reduce((acc, u) => acc + (u.subscription === 'enterprise' ? 0 : (u.balance || 0)), 0);

  const rows = users.map(user => {
    const isFrozen = user.status === 'frozen';
    const lastActiveDate = user.lastActive ? new Date(user.lastActive).toLocaleString('ar-IQ') : 'غ/م';

    const connectedAccs = Array.isArray(user.connectedAccounts) ? user.connectedAccounts : [];
    const accountsDisplay = connectedAccs.length > 0
      ? connectedAccs.map(acc => `<span class="plat-badge" title="${acc.platform}">${acc.platform === 'facebook' ? '📘' : '📸'} ${acc.pageName}</span>`).join(' ')
      : '<span style="color:#64748b; font-size:12px">لا توجد صفحات</span>';

    return `
      <tr id="user-row-${user.id}">
        <td><code>${user.id}</code></td>
        <td>
          <strong>${user.first_name || 'بدون اسم'}</strong>
          ${user.username ? `<br><small style="color:#94a3b8">@${user.username}</small>` : ''}
        </td>
        <td>
          <span class="badge ${user.subscription}">${user.subscription}</span>
        </td>
        <td>
          <strong style="font-size: 16px; color: ${user.subscription === 'enterprise' ? '#fbbf24' : '#38bdf8'}">
            ${user.subscription === 'enterprise' ? '♾️ بلا حدود' : user.balance}
          </strong>
        </td>
        <td>${accountsDisplay}</td>
        <td>
          <span class="status-pill ${isFrozen ? 'frozen' : 'active'}">
            ${isFrozen ? '❄️ مجمد' : '✅ نشط'}
          </span>
        </td>
        <td style="font-size: 12px; color: #94a3b8">${lastActiveDate}</td>
        <td>
          <div class="action-buttons">
            <button class="btn-starter" onclick="quickActivate('${user.id}', 'starter')" title="تفعيل Starter (15k - 30 منشور)">📦 Starter</button>
            <button class="btn-pro" onclick="quickActivate('${user.id}', 'pro')" title="تفعيل Pro (30k - 150 منشور)">🚀 Pro</button>
            <button class="btn-enterprise" onclick="quickActivate('${user.id}', 'enterprise')" title="تفعيل Enterprise (60k - غير محدود)">👑 Enterprise</button>
            <button class="${isFrozen ? 'btn-green' : 'btn-red'}" onclick="toggleStatus('${user.id}')">${isFrozen ? '▶️ تفعيل' : '❄️ تجميد'}</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AutoPost Dashboard - Meta OAuth & Firestore Connected</title>
  <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Tajawal', sans-serif; }
    body { background: #0b0f19; color: #f1f5f9; min-height: 100vh; padding: 20px; }
    .container { max-width: 1350px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; padding: 20px 0; border-bottom: 1px solid #1e293b; margin-bottom: 30px; }
    header h1 { font-size: 26px; color: #38bdf8; }
    .btn-logout { background: #ef4444; color: #fff; padding: 8px 16px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: bold; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .stat-card { background: rgba(30, 41, 59, 0.6); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; padding: 20px; }
    .stat-card h3 { font-size: 14px; color: #94a3b8; margin-bottom: 8px; }
    .stat-card .val { font-size: 28px; font-weight: 800; color: #f8fafc; }
    .card-panel { background: rgba(30, 41, 59, 0.6); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; padding: 24px; margin-bottom: 30px; }
    .card-panel h2 { font-size: 18px; color: #38bdf8; margin-bottom: 16px; }
    .direct-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)) 120px; gap: 12px; align-items: end; }
    .input-group label { display: block; font-size: 13px; color: #cbd5e1; margin-bottom: 6px; }
    .input-group input, .input-group select { width: 100%; padding: 10px 14px; background: #1e293b; border: 1px solid #334155; border-radius: 8px; color: #fff; font-size: 14px; outline: none; }
    .btn-submit { background: #0284c7; color: #fff; border: none; padding: 11px; border-radius: 8px; font-weight: bold; cursor: pointer; }
    .table-container { overflow-x: auto; border-radius: 12px; border: 1px solid #1e293b; }
    table { width: 100%; border-collapse: collapse; background: rgba(30, 41, 59, 0.4); text-align: right; }
    th, td { padding: 14px 16px; border-bottom: 1px solid #1e293b; }
    th { background: #1e293b; color: #94a3b8; font-size: 13px; font-weight: 700; }
    tr:hover { background: rgba(51, 65, 85, 0.3); }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: bold; }
    .badge.free { background: #334155; color: #cbd5e1; }
    .badge.starter { background: #0284c7; color: #fff; }
    .badge.pro { background: #7c3aed; color: #fff; }
    .badge.enterprise { background: #d97706; color: #fff; }
    .plat-badge { display: inline-block; background: #1e293b; border: 1px solid #334155; color: #38bdf8; padding: 4px 8px; border-radius: 6px; font-size: 11px; margin: 2px; }
    .status-pill { display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; }
    .status-pill.active { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .status-pill.frozen { background: rgba(239, 68, 68, 0.2); color: #fca5a5; }
    .action-buttons { display: flex; gap: 6px; flex-wrap: wrap; }
    .btn-starter { background: #0284c7; color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-weight: bold; font-size: 11px; cursor: pointer; }
    .btn-pro { background: #7c3aed; color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-weight: bold; font-size: 11px; cursor: pointer; }
    .btn-enterprise { background: #d97706; color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-weight: bold; font-size: 11px; cursor: pointer; }
    .btn-green { background: #10b981; color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-weight: bold; font-size: 11px; cursor: pointer; }
    .btn-red { background: #dc2626; color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-weight: bold; font-size: 11px; cursor: pointer; }
    #toast { position: fixed; bottom: 25px; left: 25px; background: #10b981; color: #fff; padding: 12px 24px; border-radius: 8px; font-weight: bold; display: none; z-index: 9999; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🤖 AutoPost Admin (Facebook OAuth & Firestore Connected)</h1>
      <a href="/admin/logout" class="btn-logout">تسجيل الخروج 🚪</a>
    </header>

    <div class="stats-grid">
      <div class="stat-card"><h3>إجمالي العملاء</h3><div class="val" style="color:#38bdf8">${totalUsers}</div></div>
      <div class="stat-card"><h3>الحسابات النشطة</h3><div class="val" style="color:#34d399">${activeUsers}</div></div>
      <div class="stat-card"><h3>الحسابات المجمدة</h3><div class="val" style="color:#fca5a5">${frozenUsers}</div></div>
      <div class="stat-card"><h3>مجموع رصيد المنشورات</h3><div class="val" style="color:#fbbf24">${totalBalance}</div></div>
    </div>

    <div class="card-panel">
      <h2>⚡ تعيين الباقات والأرصدة مباشرةً (Firestore Synchronized)</h2>
      <form id="direct-update-form" onsubmit="handleDirectUpdate(event)" class="direct-form">
        <div class="input-group">
          <label>ID العميل (Telegram User ID)</label>
          <input type="text" id="target-user-id" required placeholder="مثال: 123456789">
        </div>
        <div class="input-group">
          <label>رصيد المنشورات</label>
          <input type="number" id="target-amount" placeholder="تلقائي حسب الباقة">
        </div>
        <div class="input-group">
          <label>نوع الباقة الجديدة</label>
          <select id="target-subscription">
            <option value="starter">Starter (15,000 د.ع - 30 منشور)</option>
            <option value="pro" selected>Pro (30,000 د.ع - 150 منشور + AI)</option>
            <option value="enterprise">Enterprise (60,000 د.ع - غير محدود)</option>
            <option value="free">تجريبي Free</option>
          </select>
        </div>
        <div class="input-group">
          <label>حالة الحساب</label>
          <select id="target-status">
            <option value="active">نشط ✅</option>
            <option value="frozen">مجمد ❄️</option>
          </select>
        </div>
        <button type="submit" class="btn-submit">تحديث السحاب</button>
      </form>
    </div>

    <div class="card-panel">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h2>👥 قائمة جميع العملاء وحسابات الفيسبوك المربوطة</h2>
        <input type="text" id="search-box" onkeyup="filterUsers()" placeholder="🔍 بحث عن عميل..." style="padding:8px 14px; background:#1e293b; border:1px solid #334155; border-radius:8px; color:#fff; width:250px;">
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>ID التليجرام</th>
              <th>الاسم</th>
              <th>الباقة الحالية</th>
              <th>الرصيد المتبقي</th>
              <th>الفيسبوك / الإنستغرام</th>
              <th>الحالة</th>
              <th>آخر نشاط</th>
              <th>إجراءات التفعيل السريع</th>
            </tr>
          </thead>
          <tbody id="users-table-body">
            ${rows.length > 0 ? rows : '<tr><td colspan="8" style="text-align:center; padding:30px; color:#94a3b8">لا يوجد مستخدمون حالياً.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    function showToast(msg, isError = false) {
      const toast = document.getElementById('toast');
      toast.innerText = msg;
      toast.style.background = isError ? '#ef4444' : '#10b981';
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 3500);
    }

    async function quickActivate(userId, tier) {
      if (!confirm('هل أنت متاكد من تفعيل باقة ' + tier.toUpperCase() + ' لهذا العميل؟')) return;

      try {
        const res = await fetch('/admin/api/quick-activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, tier })
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message);
          setTimeout(() => location.reload(), 1000);
        } else {
          showToast(data.error || 'حدث خطأ', true);
        }
      } catch (err) {
        showToast('فشل الاتصال بالسيرفر', true);
      }
    }

    async function toggleStatus(userId) {
      try {
        const res = await fetch('/admin/api/toggle-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId })
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message);
          setTimeout(() => location.reload(), 1000);
        } else {
          showToast(data.error || 'حدث خطأ', true);
        }
      } catch (err) {
        showToast('فشل الاتصال بالسيرفر', true);
      }
    }

    async function handleDirectUpdate(e) {
      e.preventDefault();
      const userId = document.getElementById('target-user-id').value;
      const amount = document.getElementById('target-amount').value;
      const subscription = document.getElementById('target-subscription').value;
      const status = document.getElementById('target-status').value;

      try {
        const res = await fetch('/admin/api/update-balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, amount, subscription, status })
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message);
          setTimeout(() => location.reload(), 1000);
        } else {
          showToast(data.error || 'حدث خطأ', true);
        }
      } catch (err) {
        showToast('فشل الاتصال بالسيرفر', true);
      }
    }

    function filterUsers() {
      const q = document.getElementById('search-box').value.toLowerCase();
      const trs = document.querySelectorAll('#users-table-body tr');
      trs.forEach(tr => {
        const text = tr.innerText.toLowerCase();
        tr.style.display = text.includes(q) ? '' : 'none';
      });
    }
  </script>
</body>
</html>`;
}

module.exports = app;
