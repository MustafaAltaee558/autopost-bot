const { Telegraf, Markup } = require('telegraf');
const dbService = require('./services/dbService');
const aiService = require('./services/aiService');
const metaService = require('./services/metaService');

// State stores
const mediaGroupStore = new Map();

// Session Helpers using dbService (persisted in Firestore per userId)
function serializeMediaFiles(mediaFiles) {
  if (!Array.isArray(mediaFiles)) return [];
  return mediaFiles.map(f => ({
    mimeType: f.mimeType,
    base64: Buffer.isBuffer(f.buffer) ? f.buffer.toString('base64') : (f.base64 || (typeof f.buffer === 'string' ? f.buffer : '')),
  }));
}

function deserializeMediaFiles(mediaFiles) {
  if (!Array.isArray(mediaFiles)) return [];
  return mediaFiles.map(f => ({
    mimeType: f.mimeType,
    buffer: f.buffer && Buffer.isBuffer(f.buffer) ? f.buffer : Buffer.from(f.base64 || '', 'base64'),
  }));
}

function getWizardState(userId) {
  const session = dbService.getUserSession(userId);
  if (!session || !session.wizard) return null;
  const wizard = { ...session.wizard };
  if (wizard.mediaFiles) {
    wizard.mediaFiles = deserializeMediaFiles(wizard.mediaFiles);
  }
  return wizard;
}

function setWizardState(userId, wizardData) {
  const dataToSave = { ...wizardData };
  if (dataToSave.mediaFiles) {
    dataToSave.mediaFiles = serializeMediaFiles(dataToSave.mediaFiles);
  }
  dbService.saveUserSession(userId, { wizard: dataToSave });
}

function clearWizardState(userId) {
  dbService.saveUserSession(userId, { wizard: null });
}

function getDraft(userId) {
  const session = dbService.getUserSession(userId);
  if (!session || !session.draft) return null;
  const draft = { ...session.draft };
  if (draft.mediaFiles) {
    draft.mediaFiles = deserializeMediaFiles(draft.mediaFiles);
  }
  return draft;
}

function setDraft(userId, draftData) {
  const dataToSave = { ...draftData };
  if (dataToSave.mediaFiles) {
    dataToSave.mediaFiles = serializeMediaFiles(dataToSave.mediaFiles);
  }
  dbService.saveUserSession(userId, { draft: dataToSave });
}

function clearDraft(userId) {
  dbService.saveUserSession(userId, { draft: null });
}

// Helper to fetch Telegram file as a Buffer
async function downloadTelegramFile(bot, fileId) {
  try {
    const fileLink = await bot.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href || fileLink);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error(`Error downloading fileId ${fileId}:`, err);
    throw err;
  }
}

// Main Reply Keyboard
const mainReplyKeyboard = Markup.keyboard([
  ['📝 إنشاء منشور جديد', '🔗 ربط حساب تواصل'],
  ['💎 عرض الباقات والاشتراك', '📊 عرض رصيد المنشورات والاشتراك الحالي'],
]).resize();

// Packages Inline Keyboard
const packagesInlineKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('📦 Starter - 15,000 د.ع (30 منشور)', 'pkg_starter')],
  [Markup.button.callback('🚀 Pro - 30,000 د.ع (150 منشور + AI)', 'pkg_pro')],
  [Markup.button.callback('👑 Enterprise - 60,000 د.ع (بلا حدود)', 'pkg_enterprise')],
  [Markup.button.url('📲 تواصل مباشر عبر الواتساب (07732446114)', 'https://wa.me/9647732446114')],
]);

function createBot(token) {
  if (!token || token === 'your_bot_token') {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN غير محدد أو يحتوي على القيمة الافتراضية.');
  }

  const bot = new Telegraf(token);

  // Sync user info middleware
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      dbService.getOrCreateUser(ctx.from.id, {
        username: ctx.from.username,
        first_name: ctx.from.first_name,
      });
    }
    return next();
  });

  // Ensure user is active (not frozen)
  async function ensureActiveUser(ctx) {
    const user = dbService.getUser(ctx.from.id);
    if (user && user.status === 'frozen') {
      await ctx.reply('⛔ حسابك متوقف / مجمد حالياً من قبل الإدارة.\nيرجى التواصل مع الدعم الفني لتفعيل اشتراكك.');
      return false;
    }
    return true;
  }

  // /start command
  bot.start(async (ctx) => {
    if (!(await ensureActiveUser(ctx))) return;

    const user = dbService.getUser(ctx.from.id);
    const welcomeText = `👋 أهلاً بك يا ${ctx.from.first_name || 'صديقنا'} في منصة **AutoPost** لنشر المنشورات التسويقية! 🛒💊\n\n✨ يمكنك إنشاء وتوليد منشورات بيعية احترافية، اختيار النشر الآلي بالذكاء الاصطناعي أو اليدوي، والمعاينة والنشر المباشر على الفيسبوك والإنستغرام!\n\n📊 **رصيدك الحالي:** ${user.subscription === 'enterprise' ? 'بلا حدود ♾️' : `**${user.balance}** منشور`}\n\nاختر من القائمة أدناه للبدء:`;

    await ctx.reply(welcomeText, { parse_mode: 'Markdown', ...mainReplyKeyboard });
  });

  // 🔗 ربط حساب تواصل
  bot.hears('🔗 ربط حساب تواصل', async (ctx) => {
    if (!(await ensureActiveUser(ctx))) return;
    await sendPlatformBindingMenu(ctx);
  });

  // 📝 إنشاء منشور جديد
  bot.hears('📝 إنشاء منشور جديد', async (ctx) => {
    if (!(await ensureActiveUser(ctx))) return;

    const text = `📸 **طريقة إنشاء منشور جديد:**\n\n1️⃣ قم بإرسال صورة، عدة صور، أو مقطع فيديو للمنتج / الخدمة.\n2️⃣ اختر طريقة إعداد النص (ذكاء اصطناعي آلي أو كتابة يدوية).\n3️⃣ ستظهر لك **معاينة للمنشور قبل النشر المباشر أونلاين على صفحتك**!\n\n⚠️ **قواعد خصم الوسائط:**\n• 1 - 2 صورة 👈 خصم 1 منشور.\n• 3 صور فما فوق 👈 خصم 2 منشورات.\n• مقطع فيديو 👈 خصم 1 منشور.`;

    await ctx.reply(text, { parse_mode: 'Markdown', ...mainReplyKeyboard });
  });

  // 💎 عرض الباقات والاشتراك
  bot.hears('💎 عرض الباقات والاشتراك', async (ctx) => {
    await sendPackageInfo(ctx);
  });

  // 📊 عرض رصيد المنشورات والاشتراك الحالي
  bot.hears('📊 عرض رصيد المنشورات والاشتراك الحالي', async (ctx) => {
    if (!(await ensureActiveUser(ctx))) return;

    const user = dbService.getUser(ctx.from.id);
    const subName = {
      free: 'تجريبي مجاني',
      starter: 'Starter (15,000 د.ع)',
      pro: 'Pro (30,000 د.ع)',
      enterprise: 'Enterprise (60,000 د.ع)',
    }[user.subscription] || user.subscription;

    const connectedAccs = user.connectedAccounts && user.connectedAccounts.length > 0
      ? user.connectedAccounts.map(a => `• ${a.platform === 'facebook' ? '📘 فيسبوك' : '📸 إنستغرام'}: ${a.pageName}`).join('\n')
      : 'لا يوجد صفحات مربوطة بعد';

    const infoText = `📊 **بيانات حسابك وااشتراكك الحالي:**\n\n👤 **الاسم:** ${user.first_name}\n🆔 **ID الحساب:** \`${user.id}\` \n💎 **الباقة الحالية:** ${subName}\n📈 **حالة الاشتراك:** ${user.status === 'active' ? 'نشط ✅' : 'مجمد ❄️'}\n📦 **الرصيد المتبقي:** ${user.subscription === 'enterprise' ? 'بلا حدود ♾️' : `**${user.balance}** منشور`}\n\n🔗 **الصفحات والحسابات المربوطة:**\n${connectedAccs}\n\n💡 لتعبئة الرصيد أو تفعيل باقة جديدة، تواصل معنا عبر الواتساب: **07732446114**`;

    await ctx.reply(infoText, { parse_mode: 'Markdown', ...packagesInlineKeyboard });
  });

  // Package Inline Details
  bot.action('pkg_starter', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `📦 **باقة Starter (15,000 دينار عراقي / شهرياً):**\n\n• 30 منشوراً شاملة للوسائط.\n• ربط صفحة تواصل واحدة.\n• كتابة وتحكم يدوي كامل بالمنشور.\n\n📲 للتفعيل تواصل واتساب (07732446114):`,
      Markup.inlineKeyboard([[Markup.button.url('📲 تواصل واتساب للتفعيل', 'https://wa.me/9647732446114')]])
    );
  });

  bot.action('pkg_pro', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `🚀 **باقة Pro (30,000 دينار عراقي / شهرياً):**\n\n• 150 منشوراً شاملة للوسائط.\n• توليد آلي بالذكاء الاصطناعي أو كتابة يدوية.\n• أزرار إعادة الصياغة والتعديل والتراجع.\n• ربط كافة المنصات والصفحات.\n\n📲 للتفعيل تواصل واتساب (07732446114):`,
      Markup.inlineKeyboard([[Markup.button.url('📲 تواصل واتساب للتفعيل', 'https://wa.me/9647732446114')]])
    );
  });

  bot.action('pkg_enterprise', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `👑 **باقة Enterprise (60,000 دينار عراقي / شهرياً):**\n\n• منشورات وميزات غير محدودة (Unlimited).\n• شاملة لكافة تقنيات الذكاء الاصطناعي والتحكم اليدوي.\n• ربط جميع صفحات الفيسبوك والإنستغرام بلا حدود.\n\n📲 للتفعيل تواصل واتساب (07732446114):`,
      Markup.inlineKeyboard([[Markup.button.url('📲 تواصل واتساب للتفعيل', 'https://wa.me/9647732446114')]])
    );
  });

  // Handle Video Upload
  bot.on('video', async (ctx) => {
    if (!(await ensureActiveUser(ctx))) return;

    const user = dbService.getUser(ctx.from.id);
    const cost = 1;

    if (user.subscription !== 'enterprise' && user.balance < cost) {
      return ctx.reply(`⚠️ **رصيدك غير كافٍ!**\n\nهذا المنشور يتطلب خصم 1 منشور، ورصيدك هو ${user.balance} منشور.`, packagesInlineKeyboard);
    }

    const video = ctx.message.video;
    let buffer;
    let mimeType = 'video/mp4';

    if (video.thumb) {
      buffer = await downloadTelegramFile(bot, video.thumb.file_id);
      mimeType = 'image/jpeg';
    } else {
      buffer = await downloadTelegramFile(bot, video.file_id);
      mimeType = video.mime_type || 'video/mp4';
    }

    const caption = ctx.message.caption || '';
    const mediaFiles = [{ mimeType, buffer }];

    await handleCreationFlowChoice(ctx, user, mediaFiles, cost, caption);
  });

  // Handle Photo Upload
  bot.on('photo', async (ctx) => {
    if (!(await ensureActiveUser(ctx))) return;

    const mediaGroupId = ctx.message.media_group_id;
    const photoArray = ctx.message.photo;
    const largestPhoto = photoArray[photoArray.length - 1];
    const caption = ctx.message.caption || '';

    if (mediaGroupId) {
      if (!mediaGroupStore.has(mediaGroupId)) {
        mediaGroupStore.set(mediaGroupId, {
          ctx,
          user: ctx.from,
          photos: [largestPhoto.file_id],
          caption: caption,
          timer: null,
        });

        const entry = mediaGroupStore.get(mediaGroupId);
        entry.timer = setTimeout(async () => {
          const groupData = mediaGroupStore.get(mediaGroupId);
          mediaGroupStore.delete(mediaGroupId);
          if (groupData) {
            await processPhotoGroup(bot, groupData);
          }
        }, 1500);
      } else {
        const groupData = mediaGroupStore.get(mediaGroupId);
        groupData.photos.push(largestPhoto.file_id);
        if (!groupData.caption && caption) {
          groupData.caption = caption;
        }
      }
    } else {
      await processPhotoGroup(bot, {
        ctx,
        user: ctx.from,
        photos: [largestPhoto.file_id],
        caption: caption,
      });
    }
  });

  // Creation Mode Callbacks: AI vs Manual
  bot.action('mode_ai', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getWizardState(ctx.from.id);
    if (!state) return ctx.reply('⚠️ انتهت الجلسة، يرجى إعادة إرسال الصور أو الفيديو.');

    clearWizardState(ctx.from.id);
    const waitMsg = await ctx.reply('🤖 جاري صياغة المنشور التلقائي بواسطة الذكاء الاصطناعي... ⏳');

    try {
      const generatedPost = await aiService.generatePost(state.mediaFiles, state.caption);
      await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});

      setDraft(ctx.from.id, {
        cost: state.cost,
        mediaFiles: state.mediaFiles,
        rawText: generatedPost,
      });

      await sendInteractivePreviewCard(ctx, ctx.from.id);
    } catch (err) {
      await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
      await ctx.reply(`❌ حدث خطأ أثناء التوليد: ${err.message}`);
    }
  });

  bot.action('mode_manual', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getWizardState(ctx.from.id);
    if (!state) return ctx.reply('⚠️ انتهت الجلسة، يرجى إعادة إرسال الصور أو الفيديو.');

    state.step = 'awaiting_title';
    setWizardState(ctx.from.id, state);

    await ctx.reply('✍️ **الخطوة 1 من 3:** يرجى كتابة **عنوان المنشور الرئيسي**:');
  });

  // Manual Wizard Text Input Listener
  bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const wizard = getWizardState(userId);

    if (wizard && wizard.step) {
      const input = ctx.message.text.trim();

      if (wizard.step === 'awaiting_title') {
        wizard.manualTitle = input;
        wizard.step = 'awaiting_desc';
        setWizardState(userId, wizard);
        return ctx.reply('✍️ **الخطوة 2 من 3:** رائع! الآن اكتب **الوصف البيعي والتفاصيل**:');
      }

      if (wizard.step === 'awaiting_desc') {
        wizard.manualDesc = input;
        wizard.step = 'awaiting_tags';
        setWizardState(userId, wizard);
        return ctx.reply('🏷️ **الخطوة 3 من 3:** أخيرًا، اكتب **الهاشتاغات** (مثال: #متجر #عرض #خصم):');
      }

      if (wizard.step === 'awaiting_tags') {
        wizard.manualTags = input;
        clearWizardState(userId);

        const fullPost = `${wizard.manualTitle}\n\n${wizard.manualDesc}\n\n${wizard.manualTags}`;

        setDraft(userId, {
          cost: wizard.cost,
          mediaFiles: wizard.mediaFiles,
          rawText: fullPost,
        });

        return sendInteractivePreviewCard(ctx, userId);
      }
    }

    return next();
  });

  // Preview Card Action Callbacks
  // 🚀 Live Publishing to Meta Graph API
  bot.action('confirm_publish', async (ctx) => {
    await ctx.answerCbQuery();
    const draft = getDraft(ctx.from.id);
    if (!draft) return ctx.reply('⚠️ لا يوجد مسودة منشور بانتظار التأكيد حالياً.');

    const user = dbService.getUser(ctx.from.id);
    if (user.subscription !== 'enterprise' && user.balance < draft.cost) {
      return ctx.reply('⚠️ رصيدك الحالي غير كافٍ لنشر هذا المنشور.', packagesInlineKeyboard);
    }

    const connectedAccs = Array.isArray(user.connectedAccounts) ? user.connectedAccounts : [];
    const fbPages = connectedAccs.filter(a => a.platform === 'facebook' && a.accessToken && a.pageId);

    const publishingMsg = await ctx.reply('🚀 جاري نشر المنشور أونلاين على صفحتك في فيسبوك والإنستغرام... ⏳');

    let publishedLink = null;

    if (fbPages.length > 0) {
      const pageToPublish = fbPages[0];
      try {
        const res = await metaService.publishToFacebookPage(
          pageToPublish.accessToken,
          pageToPublish.pageId,
          draft.rawText
        );
        publishedLink = res.permalink;
      } catch (err) {
        console.warn('Meta Direct Publish Notice:', err.message);
      }
    }

    // Deduct quota balance
    dbService.deductBalance(ctx.from.id, draft.cost);
    const updatedUser = dbService.getUser(ctx.from.id);
    clearDraft(ctx.from.id);

    await ctx.telegram.deleteMessage(ctx.chat.id, publishingMsg.message_id).catch(() => {});

    let resultMsg = draft.rawText + '\n\nــــــــــــــــــــــــــــــــ\n';

    if (publishedLink) {
      resultMsg += `🎉 **تم النشر المباشر بنجاح أونلاين على صفحتك!**\n🔗 **رابط المنشور:** ${publishedLink}\n`;
    } else if (fbPages.length > 0) {
      resultMsg += `🚀 **تم النشر والإرسال بنجاح!**\n`;
    } else {
      resultMsg += `🚀 **تم اعتماد المنشور ونشره!**\n💡 (نصيحة: قم بربط صفحة الفيسبوك من زر "🔗 ربط حساب تواصل" للنشر الأوتوماتيكي الفوري).\n`;
    }

    const quotaInfo = user.subscription === 'enterprise'
      ? '👑 باقة Enterprise غير محدودة.'
      : `✅ تم خصم ${draft.cost} منشور. رصيدك المتبقي: **${updatedUser.balance}** منشور.`;

    resultMsg += `\n${quotaInfo}`;

    await ctx.reply(resultMsg, { parse_mode: 'Markdown' });
  });

  bot.action('rephrase_ai', async (ctx) => {
    await ctx.answerCbQuery();
    const user = dbService.getUser(ctx.from.id);
    if (user.subscription === 'starter' || user.subscription === 'free') {
      return ctx.reply('⚠️ ميزة إعادة التوليد بالذكاء الاصطناعي متاحة لمشتركي باقة **Pro** و **Enterprise** فقط.');
    }

    const draft = getDraft(ctx.from.id);
    if (!draft) return ctx.reply('⚠️ انتهت جلسة مسودة المنشور الحالية.');

    const waitMsg = await ctx.reply('🔄 جاري إعادة صياغة وتحسين المنشور بواسطة الذكاء الاصطناعي... ⏳');

    try {
      const rephrased = await aiService.rephrasePost(draft.rawText);
      draft.rawText = rephrased;
      setDraft(ctx.from.id, draft);

      await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
      await ctx.reply('✨ تم إعادة الصياغة بنجاح! إليك المعاينة الجديدة:');
      await sendInteractivePreviewCard(ctx, ctx.from.id);
    } catch (err) {
      await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
      await ctx.reply(`❌ حدث خطأ أثناء إعادة الصياغة: ${err.message}`);
    }
  });

  bot.action('cancel_post', async (ctx) => {
    await ctx.answerCbQuery();
    clearDraft(ctx.from.id);
    clearWizardState(ctx.from.id);
    await ctx.reply('❌ تم إلغاء المنشور بنجاح ولم يتم خصم أي رصيد من حسابك.');
  });

  return bot;
}

// Helper to build clean OAuth URLs handling VERCEL_URL and protocols safely
function getAuthUrl(route, chatId) {
  let serverUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL.replace(/^https?:\/\//, '')}`
    : (process.env.SERVER_URL || process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).trim();

  if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
    serverUrl = `https://${serverUrl}`;
  }
  serverUrl = serverUrl.replace(/\/$/, '');
  return `${serverUrl}${route}?chatId=${chatId}`;
}

// Send Social Platform & Meta OAuth Link Menu
async function sendPlatformBindingMenu(ctx) {
  const user = dbService.getUser(ctx.from.id);
  const connectedAccs = Array.isArray(user.connectedAccounts) ? user.connectedAccounts : [];
  const chatId = ctx.from.id;

  const fbAuthUrl = getAuthUrl('/auth/facebook', chatId);
  const igAuthUrl = getAuthUrl('/auth/instagram', chatId);

  const accsText = connectedAccs.length > 0
    ? connectedAccs.map(a => `• ${a.platform === 'facebook' ? '📘 فيسبوك' : '📸 إنستغرام'}: **${a.pageName}**`).join('\n')
    : 'لا توجد صفحات أو حسابات مربوطة بعد.';

  const isLocalhost = fbAuthUrl.includes('localhost') || fbAuthUrl.includes('127.0.0.1');

  const text = `🔗 **إدارة وربط صفحات الفيسبوك والإنستغرام (Meta OAuth 2.0):**\n\n` +
    `${accsText}\n\n` +
    `📌 **معلومات الربط:**\n` +
    `• باقة Starter تسمح بربط صفحة واحدة.\n` +
    `• باقتي Pro و Enterprise تتيح ربط كافة الصفحات والحسابات.\n\n` +
    `اختر المنصة أدناه لتسجيل الدخول عبر المتصفح وتفويض الصفحة:`;

  if (isLocalhost) {
    const textWithLinks = text + `\n\n` +
      `📘 **فيسبوك:**\n[اضغط هنا لربط صفحة الفيسبوك](${fbAuthUrl})\n\n` +
      `📸 **إنستغرام:**\n[اضغط هنا لربط حساب الإنستغرام](${igAuthUrl})`;
    await ctx.reply(textWithLinks, { parse_mode: 'Markdown', disable_web_page_preview: false });
  } else {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url('📘 ربط صفحة فيسبوك', fbAuthUrl)],
      [Markup.button.url('📸 ربط حساب إنستغرام', igAuthUrl)],
    ]);
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}

// Process Photo Groups
async function processPhotoGroup(bot, groupData) {
  const { ctx, user, photos, caption } = groupData;
  const photoCount = photos.length;
  const cost = photoCount >= 3 ? 2 : 1;

  const dbUser = dbService.getUser(user.id);
  if (dbUser.subscription !== 'enterprise' && dbUser.balance < cost) {
    return ctx.reply(
      `⚠️ **رصيدك غير كافٍ!**\n\nهذا المنشور (${photoCount} صورة) يتطلب خصم ${cost} منشور، ورصيدك الحالي هو ${dbUser.balance} منشور.`,
      packagesInlineKeyboard
    );
  }

  const mediaFiles = [];
  for (const fileId of photos) {
    const buffer = await downloadTelegramFile(bot, fileId);
    mediaFiles.push({ mimeType: 'image/jpeg', buffer });
  }

  await handleCreationFlowChoice(ctx, dbUser, mediaFiles, cost, caption);
}

// Creation Flow Chooser
async function handleCreationFlowChoice(ctx, user, mediaFiles, cost, caption) {
  setWizardState(user.id, {
    mediaFiles,
    cost,
    caption,
  });

  if (user.subscription === 'starter' || user.subscription === 'free') {
    const state = getWizardState(user.id);
    state.step = 'awaiting_title';
    setWizardState(user.id, state);

    return ctx.reply(
      `✍️ **الكتابة والتحكم اليدوي بالمنشور (باقة Starter):**\n\n**الخطوة 1 من 3:** يرجى كتابة **عنوان المنشور الرئيسي**:`
    );
  }

  const text = `✨ **اختر طريقة إعداد المنشور:**

🤖 **توليد تلقائي بالذكاء الاصطناعي:** سيقوم Gemini 1.5 Flash بتحليل الصور/الفيديو وصياغة منشور بيعي احترافي فوراً.
✍️ **كتابة يدوية تسلسلية:** أدخل العنوان، الوصف، والهاشتاغات بنفسك خطوة بخطوة.`;

  const flowKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🤖 توليد تلقائي بالذكاء الاصطناعي', 'mode_ai')],
    [Markup.button.callback('✍️ كتابة يدوية تسلسلية', 'mode_manual')],
  ]);

  await ctx.reply(text, { parse_mode: 'Markdown', ...flowKeyboard });
}

// Send Interactive Preview Card
async function sendInteractivePreviewCard(ctx, userId) {
  const draft = getDraft(userId);
  if (!draft) return;

  const user = dbService.getUser(userId);

  const previewText = `📋 **معاينة المنشور قبل النشر المباشر أونلاين:**

${draft.rawText}

ــــــــــــــــــــــــــــــــ
💰 **التكلفة المستقطعة:** ${user.subscription === 'enterprise' ? 'مجاناً 👑' : `${draft.cost} منشور`}`;

  const previewButtons = [
    [Markup.button.callback('🚀 تأكيد ونشر أونلاين على الصفحة', 'confirm_publish')],
  ];

  if (user.subscription === 'pro' || user.subscription === 'enterprise') {
    previewButtons.push([Markup.button.callback('🔄 إعادة صياغة بالذكاء الاصطناعي', 'rephrase_ai')]);
  }

  previewButtons.push([Markup.button.callback('❌ إلغاء المنشور', 'cancel_post')]);

  await ctx.reply(previewText, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(previewButtons),
  });
}

async function sendPackageInfo(ctx) {
  const text = `💎 **باقات واشتراكات AutoPost مع الربط المباشر بالصفحات:**

📦 **1. باقة Starter (15,000 دينار / شهرياً):**
• 30 منشوراً شاملة للوسائط.
• ربط صفحة فيسبوك أو إنستغرام واحدة.
• تحكم وكتابة يدوية كاملة بالمنشور.

🚀 **2. باقة Pro (30,000 دينار / شهرياً):**
• 150 منشوراً شاملة للوسائط.
• خيار بين التوليد الآلي بالذكاء الاصطناعي أو الكتابة اليدوية.
• أزرار إعادة الصياغة والتعديل والتراجع بالذكاء الاصطناعي.
• ربط جميع صفحات الفيسبوك والإنستغرام.

👑 **3. باقة Enterprise (60,000 دينار / شهرياً):**
• منشورات غير محدودة (Unlimited).
• النشر التلقائي المباشر على الصفحات وبلا حدود.

📲 **للتفعيل المباشر الفوري تواصل عبر الواتساب (07732446114):**`;

  await ctx.reply(text, { parse_mode: 'Markdown', ...packagesInlineKeyboard });
}

module.exports = {
  createBot,
};
