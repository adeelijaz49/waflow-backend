// AI content generation for the Instagram Promotion Builder — reuses the
// same configured Anthropic client AI Mode already uses (ai/client.js,
// imported read-only, not modified). Every result here is a draft: the
// merchant must review and can edit before saving/scheduling/publishing —
// nothing here ever calls Instagram's publish API itself.
const anthropic = require('../ai/client');

const MODEL = 'claude-sonnet-5';

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI response did not contain JSON');
  return JSON.parse(match[0]);
}

// One call generates the whole first draft — caption, a shorter variant,
// hashtags, and the WhatsApp CTA line — so the merchant sees a complete
// starting point rather than four separate round trips.
async function generateContent({ businessName, goal, offerDescription, productOrServiceName }) {
  const prompt = `You are writing Instagram promotion content for a WhatsApp-commerce merchant called "${businessName || 'this business'}".
Goal: ${goal || 'new_customers'}
Offer: ${offerDescription || '(no specific offer given — write something generally inviting)'}
${productOrServiceName ? `Product/service being promoted: ${productOrServiceName}` : ''}

Write Instagram content that drives people to message the business on WhatsApp to claim the offer. Respond with ONLY a JSON object, no other text, shaped exactly like:
{"caption": "...", "shortCaption": "...", "hashtags": ["tag1","tag2", ...up to 10 lowercase tags, no # symbol], "whatsappCta": "one short line telling the reader to message on WhatsApp to claim it"}`;

  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  // Extended thinking puts a 'thinking' block before the 'text' block, so
  // content[0] isn't reliably the answer — same lookup ai/agent.js uses.
  const text = res.content.find(b => b.type === 'text')?.text || '';
  const parsed = extractJson(text);
  return {
    caption: parsed.caption || '', shortCaption: parsed.shortCaption || '',
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 10) : [],
    whatsappCta: parsed.whatsappCta || '',
  };
}

// Covers every "make this more premium" / "make it shorter" / "add Arabic
// version" style request as one flexible free-text instruction, rather than
// a separate button per variant — simpler surface, same capability.
async function refineContent({ currentCaption, instruction }) {
  const prompt = `Here is an Instagram caption for a WhatsApp-commerce merchant:
"""
${currentCaption || ''}
"""
Apply this instruction and return ONLY the revised caption text, nothing else, no quotes, no explanation:
${instruction}`;

  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });
  return (res.content.find(b => b.type === 'text')?.text || '').trim();
}

module.exports = { generateContent, refineContent };
