const { GoogleGenAI } = require('@google/genai');

/**
 * Strict post cleaning function to remove any intro, headers, or dividers.
 * Returns only clean, publish-ready text.
 */
function cleanPostOutput(text) {
  if (!text || typeof text !== 'string') return '';

  let cleaned = text;

  // 1. Remove horizontal line dividers (***, ---, ===, ___)
  cleaned = cleaned.replace(/^[*\-_=]{3,}\s*$/gm, '');

  // 2. Remove intro greetings and conversational filler lines
  const introPatterns = [
    /^.*أهلاً بك.*$/gm,
    /^.*مرحباً بك.*$/gm,
    /^.*بصفتي مستشار.*$/gm,
    /^.*إليك المنشور.*$/gm,
    /^.*المنشور البيعي.*$/gm,
    /^.*هذا هو المنشور.*$/gm,
    /^.*تفضل المنشور.*$/gm,
    /^.*إليك النص الإعلاني.*$/gm,
    /^.*بصفتي خبير.*$/gm,
  ];

  introPatterns.forEach(pattern => {
    cleaned = cleaned.replace(pattern, '');
  });

  // 3. Remove structural headers (Hook:, CTA:, الوصف البيعي:, الهاشتاغات:, etc.) at start of line or after spaces
  const headerRegex = /^[ \t]*(?:Hook|CTA|Call to Action|الوصف البيعي|الوصف التسويقي|الوصف|الهاشتاغات|الهاشتاج|العنوان|الهوك|الفكرة|النص البيعي)\s*[:\-]\s*/gim;
  cleaned = cleaned.replace(headerRegex, '');

  // Inline occurrences of headers
  const inlineHeaderRegex = /(?:Hook|CTA|Call to Action|الوصف البيعي|الوصف التسويقي|الهاشتاغات|الهاشتاج|الهوك|النص البيعي)\s*[:\-]\s*/gi;
  cleaned = cleaned.replace(inlineHeaderRegex, '');

  // 4. Remove leftover standalone asterisks or bullet markers
  cleaned = cleaned.replace(/^[ \t]*\*[ \t]*$/gm, '');

  // 5. Trim redundant empty lines (max 2 consecutive newlines)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * System Prompt enforcing direct commercial sales posts without introductions or structural tags.
 */
const STRICT_SYSTEM_PROMPT = `أنت خبير تسويق محترف ومتخصص في كتابة منشورات إعلانية عالية التحويل للمتاجر والصيدليات والأنشطة التجارية.
وظيفتك: تحليل الصور والفيديوهات والنص المرفق، ثم كتابة منشور تسويقي بيعي مباشر ومؤثر جداً يهدف لزيادة المبيعات والطلبات فوراً.

قواعد صارمة جداً (ممنوع مخالفتها إطلاقاً):
1. اكتب المنشور البيعي الصافي مباشرةً فقط!
2. يُحظر كلياً كتابة أي مقدمات أو تحيات أو عبارات تمهيدية (مثل: أهلاً بك، بصفتي مستشار، إليك المنشور، المنشور البيعي، تفضل المنشور).
3. يُحظر كلياً استخدام العناوين الهيكلية أو التصنيفية (مثل: Hook: ، CTA: ، الوصف البيعي: ، الهاشتاغات: ، العنوان:).
4. يُحظر كلياً استخدام الفواصل الخطية أو الفواصل الرمزية (مثل: *** ، --- ، ===).
5. صغ المنشور بأسلوب مشوق ومقنع، واذكر مزايا المنتج والفوائد والأسعار/العرض وطريقة الطلب بصورة سلسة متكاملة في المنشور نفسه.
6. اختم المنشور بهاشتاغات مناسبة للمتجر/الصيدلية مدمجة في نهاية المنشور مباشرة دون كتابة كلمة "الهاشتاغات:".`;

/**
 * Generate post using Gemini 2.5 Flash Vision API
 * @param {Array<{mimeType: string, buffer: Buffer}>} mediaFiles List of media items (images/videos)
 * @param {string} userCaption Optional additional prompt/text from user
 */
async function generatePost(mediaFiles = [], userCaption = '') {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_key') {
    throw new Error('GEMINI_API_KEY غير مضبوط في ملف .env');
  }

  const ai = new GoogleGenAI({ apiKey });

  // Prepare prompt contents
  const contentsParts = [];

  // Add media parts if provided
  if (Array.isArray(mediaFiles) && mediaFiles.length > 0) {
    for (const file of mediaFiles) {
      contentsParts.push({
        inlineData: {
          mimeType: file.mimeType,
          data: file.buffer.toString('base64'),
        },
      });
    }
  }

  // Add prompt instructions
  let textPrompt = 'قم بتحليل المواد المرفقة وإنشاء منشور بيعي احترافي جذاب متكامل وفق التعليمات الصارمة.';
  if (userCaption && userCaption.trim().length > 0) {
    textPrompt += `\nملاحظات وتفاصيل إضافية من العميل: ${userCaption.trim()}`;
  }
  contentsParts.push({ text: textPrompt });

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: contentsParts,
      config: {
        systemInstruction: STRICT_SYSTEM_PROMPT,
        temperature: 0.7,
      },
    });

    const rawText = response.text || '';
    const cleanText = cleanPostOutput(rawText);

    return cleanText;
  } catch (error) {
    console.error('Gemini API Error:', error);
    throw new Error(`فشل توليد المنشور بواسطة الذكاء الاصطناعي: ${error.message}`);
  }
}

/**
 * Rephrase an existing post draft with AI for better conversion & engagement.
 */
async function rephrasePost(originalText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_key') {
    throw new Error('GEMINI_API_KEY غير مضبوط في ملف .env');
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `أعد صياغة المنشور التسويقي التالي بأسلوب أقوى وأكثر جاذبية لزيادة المبيعات، مع الحفاظ على الفكرة الأساسية والعرض. 
المنشور الحالي:
${originalText}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: [{ text: prompt }],
      config: {
        systemInstruction: STRICT_SYSTEM_PROMPT,
        temperature: 0.8,
      },
    });

    const rawText = response.text || '';
    return cleanPostOutput(rawText);
  } catch (error) {
    console.error('Gemini Rephrase Error:', error);
    throw new Error(`فشل إعادة الصياغة بالذكاء الاصطناعي: ${error.message}`);
  }
}

module.exports = {
  generatePost,
  rephrasePost,
  cleanPostOutput,
  STRICT_SYSTEM_PROMPT,
};
