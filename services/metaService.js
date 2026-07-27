/**
 * Meta Graph API Service for Facebook Pages & Instagram Business Accounts Publishing
 */

/**
 * Publish post to a Facebook Page
 */
async function publishToFacebookPage(pageAccessToken, pageId, message, imageUrl = null) {
  if (!pageAccessToken || !pageId) {
    throw new Error('بيانات تصريح الصفحة (Page Access Token / Page ID) غير متوفرة.');
  }

  let endpoint = `https://graph.facebook.com/v19.0/${pageId}/feed`;
  const bodyData = {
    access_token: pageAccessToken,
  };

  if (imageUrl) {
    endpoint = `https://graph.facebook.com/v19.0/${pageId}/photos`;
    bodyData.url = imageUrl;
    bodyData.caption = message;
  } else {
    bodyData.message = message;
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyData),
    });

    const result = await response.json();
    if (result.error) {
      throw new Error(result.error.message || 'فشل النشر على صفحة الفيسبوك');
    }

    const postId = result.id || result.post_id;
    return {
      success: true,
      postId: postId,
      permalink: `https://facebook.com/${postId}`,
    };
  } catch (err) {
    console.error('Facebook Publish Error:', err);
    throw new Error(`خطأ في النشر على فيسبوك: ${err.message}`);
  }
}

/**
 * Publish photo post to Instagram Business Account
 */
async function publishToInstagram(pageAccessToken, igAccountId, caption, imageUrl) {
  if (!pageAccessToken || !igAccountId) {
    throw new Error('بيانات حساب إنستغرام التجاري غير متوفرة.');
  }
  if (!imageUrl) {
    throw new Error('نشر إنستغرام يتطلب رابط صورة مباشر.');
  }

  try {
    // 1. Create Media Container
    const containerUrl = `https://graph.facebook.com/v19.0/${igAccountId}/media`;
    const containerRes = await fetch(containerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: imageUrl,
        caption: caption,
        access_token: pageAccessToken,
      }),
    });

    const containerData = await containerRes.json();
    if (containerData.error) {
      throw new Error(containerData.error.message || 'فشل إنشاء حاوية الوسائط لإنستغرام');
    }

    const creationId = containerData.id;

    // 2. Publish Media Container
    const publishUrl = `https://graph.facebook.com/v19.0/${igAccountId}/media_publish`;
    const publishRes = await fetch(publishUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: creationId,
        access_token: pageAccessToken,
      }),
    });

    const publishData = await publishRes.json();
    if (publishData.error) {
      throw new Error(publishData.error.message || 'فشل نشر منشور إنستغرام');
    }

    return {
      success: true,
      mediaId: publishData.id,
    };
  } catch (err) {
    console.error('Instagram Publish Error:', err);
    throw new Error(`خطأ في النشر على إنستغرام: ${err.message}`);
  }
}

module.exports = {
  publishToFacebookPage,
  publishToInstagram,
};
