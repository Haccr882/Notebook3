// backend/api/generate.js
//
// MULTI-AGENT ARCHITECTURE:
//   1. PLAN — one small, fast call decides the document's structure: how
//      many sections it genuinely needs for THIS topic (no fixed page
//      target — see PLAN_PROMPT) and what each section covers. No content
//      yet.
//   2. SECTIONS — the frontend then calls this endpoint ONCE PER SECTION,
//      IN PARALLEL (Promise.all — see index.html), each one a small,
//      independent call that writes just that one section in full.
//   3. ASSEMBLE — the frontend numbers and assembles the sections itself
//      (never trusting the AI to number correctly), and retries any single
//      section that comes back broken or incomplete against the plan.
//
// MULTI-PROVIDER FALLBACK: every plan/section call tries a CHAIN of AI
// providers in order (see api/providers.js) — OpenRouter's free model,
// then Groq (fast Llama 3.3 70B), then Gemini Flash, then NVIDIA, then
// OpenRouter's fallback model — and uses whichever one answers first
// successfully. A provider whose API key isn't configured is skipped, not
// treated as a failure, so the app keeps working with a partial setup.
//
// RATE LIMITING: the daily limit counts once per user-initiated document
// (the "plan" call), not once per section — see isContinuation below.

import { callWithFallback } from './providers.js';
import { checkPremiumToken, checkAndIncrementLimit, getClientIp } from './_limits.js';

const DAILY_LIMIT = 5;
const PREMIUM_DAILY_LIMIT = 10;
const TOKENS_PER_CALL = 4000; // just under the smallest chain model's hard cap
const HEAVY_SECTION_TOKENS = 6500;

// Order matters: fastest/cheapest first, most-different-infrastructure last
// (so a single provider outage or shared-quota exhaustion doesn't take out
// more than one link in the chain at a time). Grok (xAI) and Groq's
// gpt-oss-120b are both in the mix now, not just OpenRouter/NVIDIA.
const SECTION_PROVIDER_CHAIN = ['openrouter', 'grok', 'groq', 'gemini', 'nvidia', 'openrouterFallback'];
const PLAN_PROVIDER_CHAIN = ['openrouter', 'grok', 'groq', 'gemini', 'nvidia', 'openrouterFallback'];

const SHARED_RULES = `Math notation: NEVER use LaTeX commands like \\frac, \\sin, $...$, \\theta. Instead write math in plain readable text using Unicode symbols: θ, π, √, °, ², ³, ×, ÷, ±, ≤, ≥, ∠, △.

Use **double asterisks** to bold: question labels (e.g. **Q1.**), part labels (e.g. **(a)**, **(b)**), and short key terms/final answers. Don't bold whole sentences.

"content" must ALWAYS be a single plain text string — flowing prose. NEVER put nested JSON or extra key-value sub-fields inside "content".

QUALITY: Write like a genuinely excellent teacher, not a generic AI summary. Use specific, concrete numbers, named examples, and real formulas — never vague filler like "various factors" or "several examples exist" where an actual example belongs. For a worked numerical, show every calculation step with real numbers, not just the method described in words.

COMPLETENESS: If you were given a questionCount, you MUST write exactly that many fully numbered questions (or answers) — never fewer. Do not stop early, skip a question number, or summarize "and so on" — every single question/answer in your assigned range must be fully written out. Never write a placeholder like "[continue similarly]" — every section must be finished, real, complete content.`;

const PLAN_PROMPT = `You are Notebook's planning agent. A student has made a request for study notes or a specimen/exam paper. Your ONLY job right now is to decide the document's structure — NOT write any content yet.

Return ONLY valid JSON, no commentary, matching exactly:
{
  "type": "notes" or "specimen",
  "title": "a clear title for the whole document",
  "markScheme": "for a specimen paper: one precise paragraph stating the EXACT structure — e.g. 'Section A: 5 MCQs, 1 mark each = 5 marks. Section B: 4 VSA, 2 marks each = 8 marks. Section C: 3 SA, 3 marks each = 9 marks. Section D: 2 LA, 4 marks each = 8 marks. Total = 30 marks, matching the requested total.' For notes, leave this as an empty string.",
  "sections": [
    { "heading": "Section heading", "questionCount": 0 }
  ]
}

"questionCount" = how many numbered questions THIS section contains (0 for non-question sections like an overview or notes topic).

LENGTH: there is NO fixed page count to hit. Size the document ENTIRELY by how much a genuinely thorough treatment of THIS topic needs — a narrow, single-concept topic may only need 3-4 short sections; a broad chapter may need many more. Never pad with generic filler sections just to make it longer, and never cut a topic short to save space. Go only as deep and as wide as the topic itself genuinely requires — nothing more, nothing less.

Rules for deciding sections:
- If this is STUDY NOTES: pick from Overview, Key Concepts, Important Definitions, Formulas/Laws, Worked Examples, Quick Revision Summary — use ONLY as many of these as genuinely fit the topic's breadth (skip any that don't add real value for this specific topic). Keep it tight and exam-focused like a genuine topper's revision notes — no filler sections, no "Common Mistakes" or "Exam Tips" padding sections. questionCount is 0 for all of these. markScheme is "".
- If this is a SPECIMEN/EXAM PAPER: base the structure on how THIS SPECIFIC board, class, and subject's REAL exams are genuinely structured — not a generic template. Work out the EXACT mark arithmetic for your chosen structure and write it precisely into "markScheme" — this exact text is shown to every section-writer so they all agree with each other and the Overview. Verified real current patterns to match (adapt the marks proportionally if the student asks for a different total, but keep the same section SHAPE):
  - CBSE Class 10 Maths/Science-style papers (80 marks, 3 hours): FIVE sections A-E. Section A = MCQs incl. Assertion-Reason, 1 mark each (largest question count). Section B = Very Short Answer, 2 marks each. Section C = Short Answer, 3 marks each. Section D = Long Answer, 5 marks each. Section E = 3-4 Case-Study questions, 4-5 marks each with sub-parts (e.g. 1+1+2 marks). Internal choice in 2 questions each of B/C/D and in the case-study sub-parts of E. No internal choice in A. This is the current real structure — do NOT use an old-style 4-section "A-D, no case study" layout for CBSE Maths/core subjects.
  - CBSE Class 10 Science is additionally sectioned by SUBJECT: Section A = Biology, B = Chemistry, C = Physics, each internally containing a mix of question types.
  - CBSE Class 10 Social Science: Section A = History, B = Geography, C = Political Science, D = Economics.
  - ICSE Class 10 (e.g. Physics/Chemistry/Biology, 80 theory marks, 2 hours): only TWO sections. Section A = 40 marks, compulsory, short-form questions covering the entire syllabus (definitions, short numericals, conceptual reasoning — no choice). Section B = 40 marks, the student answers 4 out of 6 longer application/numerical questions with diagrams. Do NOT invent a CBSE-style A-E structure for ICSE — this 2-section shape is correct and different on purpose.
  - If the student doesn't specify a board, default to the CBSE-style structure above (most common), but state the assumption briefly in the Overview section.
  - If you're unsure of the exact modern convention for a board/subject not covered above, reason from what's realistic and common for that level rather than defaulting to one fixed template — and keep the section count/shape simple and plausible rather than guessing an elaborate structure you're not confident in.
  - Start with "Paper Overview & Instructions" (questionCount: 0) — restating the markScheme you decided.
  - CRITICAL: do NOT create one single "Answer Key" section for the whole paper — a full answer key in one chunk is too large to generate reliably. Instead create ONE SEPARATE answer-key section immediately after each question section, named like "Answer Key — Section A", "Answer Key — Section B", etc. Each answer-key section's questionCount should match the question section it answers.
- If the student specifies a page count or total marks, size sections/questionCounts so the total genuinely adds up to that target — this must be arithmetically exact, not approximate.
- Each heading must be specific enough that another AI could write that ONE section well without seeing the others.
- Hard technical safety limit: never propose more than 40 sections total (this exists only to keep the request from timing out — almost no real request should ever get near it; do not treat it as a target).`;

function sectionPrompt(type){
  const typeRules = type === 'specimen'
    ? `This is one section of a specimen/exam paper. The paper's exact mark scheme (decided already, shared with every section so they all agree) is given below as "markScheme" — follow it exactly, do not invent different question counts or mark values. If this section is a question section (MCQ/VSA/SA/LA), write the actual questions with marks shown, and internal "OR" choices where realistic — number them starting from the "startingQuestionNumber" given below (e.g. if it's 6, your questions are Q6, Q7, Q8...). If this section is an Answer Key for a specific earlier section, give the full worked solution for exactly the question numbers in that section's range (matching startingQuestionNumber and questionCount), nothing else. If this section is the Paper Overview, restate the markScheme accurately as part of your content.`
    : `This is one section of a student's study notes — write it like the best teacher in school explaining it one-on-one, not a textbook summary. These should read like a genuine TOPPER'S handwritten notes: clean, focused, exam-ready — never bloated with filler. Requirements for genuinely good notes:
- Never give a one-line definition and move on — always follow it with why it matters, what it means in practice, and how it's tested.
- For a "Worked Examples" section, include at least TWO fully solved examples of different difficulty (one straightforward, one that combines concepts) — never just one.
- For "Key Concepts" or "Formulas" sections, add ONE memory aid per tricky concept (a mnemonic, a comparison, or a "students often confuse X with Y because...") — real teachers do this, generic AI summaries don't.
- Connect ideas to what a student can picture or has seen before, not just abstract statements.
- Never use vague hedge phrases like "there are many factors" or "in various situations" — always name the actual factors/situations.
- Stay tightly on-topic — go through exactly what this heading covers and nothing else; don't wander into adjacent topics that belong in a different section.`;

  return `You are Notebook's writing agent, an experienced school teacher. You're writing ONE section of a larger document. Stay focused only on the section you're asked for.

Return ONLY valid JSON, no commentary, matching exactly:
{
  "heading": "the section heading (repeat exactly as given)",
  "explanation": "1-2 plain-language sentences on what this section covers",
  "content": "the FULL content of this section — thorough and complete, written like a teacher explaining on a board, not robotic",
  "diagram": "OPTIONAL raw SVG string — see DIAGRAM rules below. Omit this key entirely if no diagram is needed."
}

DIAGRAM rules: include a "diagram" whenever the section is ABOUT something a real teacher would draw — ray/light diagrams (refraction, reflection, lenses), circuit diagrams, geometry figures (triangles, circles with labelled parts), force/vector diagrams, labelled biological structures, graphs of a relationship. If the content mentions "draw a diagram" or describes a physical setup, you MUST include one — don't just describe it in words and skip the visual. Format requirements (follow EXACTLY, this is validated and stripped if wrong):
- Must start with <svg viewBox="0 0 400 260"> and end with </svg> — no width/height attributes on the svg tag itself.
- Only these child tags: <line> <path> <circle> <rect> <polygon> <text> <g>. No <script>, no event handler attributes (onclick etc), no <image>, no external references.
- Use stroke="#23301F" for lines/shapes, fill="none" unless deliberately filling a shape, <text font-size="12" fill="#23301F"> for labels.
Example of a valid diagram (a simple ray bending at a boundary):
"diagram": "<svg viewBox=\\"0 0 400 260\\"><line x1=\\"0\\" y1=\\"130\\" x2=\\"400\\" y2=\\"130\\" stroke=\\"#23301F\\" stroke-width=\\"1\\"/><line x1=\\"200\\" y1=\\"20\\" x2=\\"200\\" y2=\\"240\\" stroke=\\"#23301F\\" stroke-width=\\"1\\"/><line x1=\\"80\\" y1=\\"40\\" x2=\\"200\\" y2=\\"130\\" stroke=\\"#B8722E\\" stroke-width=\\"2\\"/><line x1=\\"200\\" y1=\\"130\\" x2=\\"260\\" y2=\\"240\\" stroke=\\"#B8722E\\" stroke-width=\\"2\\"/><text x=\\"60\\" y=\\"35\\" font-size=\\"12\\" fill=\\"#23301F\\">Incident ray</text><text x=\\"210\\" y=\\"15\\" font-size=\\"12\\" fill=\\"#23301F\\">Normal</text></svg>"

${typeRules}

${SHARED_RULES}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { mode, userRequest, sectionHeading, type, isContinuation, startingQuestionNumber, questionCount, markScheme, premiumToken, continueFrom } = req.body || {};
  if (mode !== 'plan' && mode !== 'section') {
    return res.status(400).json({ error: 'Request must include mode: "plan" or "section".' });
  }
  if (!userRequest) {
    return res.status(400).json({ error: 'Request must include "userRequest".' });
  }

  // The daily limit counts once per document (the plan call). All section
  // calls that follow it are part of the SAME user-initiated generation.
  // A valid premium token (from a redeemed code — see api/redeem.js) gets
  // a higher limit than the free tier.
  if (!isContinuation) {
    const isPremium = await checkPremiumToken(premiumToken);
    const limit = isPremium ? PREMIUM_DAILY_LIMIT : DAILY_LIMIT;
    const ip = getClientIp(req);
    const limitResult = await checkAndIncrementLimit(ip, limit, 'nb');
    if (!limitResult.allowed) {
      return res.status(429).json({ error: `Daily limit reached (${limit} per day). ${isPremium ? '' : 'Upgrade to Premium for more, or '}try again after midnight.` });
    }
  }

  let chatMessages;
  if (mode === 'plan') {
    chatMessages = [
      { role: 'system', content: PLAN_PROMPT },
      { role: 'user', content: userRequest },
    ];
  } else {
    if (!sectionHeading) {
      return res.status(400).json({ error: 'Section mode requires "sectionHeading".' });
    }
    chatMessages = [
      { role: 'system', content: sectionPrompt(type) },
      { role: 'user', content: `Overall document request: "${userRequest}"${markScheme ? `\nAgreed mark scheme (follow exactly, all sections must match this): ${markScheme}` : ''}\n\nWrite ONLY this section: "${sectionHeading}"${questionCount ? `\nstartingQuestionNumber: ${startingQuestionNumber}\nquestionCount: ${questionCount}` : ''}` },
    ];
    // If this section got cut off last time, ask the model to continue the
    // SAME raw JSON text exactly where it stopped, instead of starting over
    // — this is what fixes truncated content, dropped answer-key entries,
    // and questions that silently went missing near the end of a section.
    if (continueFrom) {
      chatMessages.push({ role: 'assistant', content: continueFrom });
      chatMessages.push({ role: 'user', content: 'Continue exactly where you left off. Output only the next raw chunk of the same JSON — no repetition, no restarting, no commentary. Make sure every question up to questionCount is still fully written.' });
    }
  }

  // Heavy sections (many questions, or an Answer Key with full worked
  // solutions) need more room than a short Overview section.
  const isHeavySection = mode === 'section' && (questionCount > 3 || /answer key/i.test(sectionHeading || ''));
  const dynamicTokens = isHeavySection ? HEAVY_SECTION_TOKENS : TOKENS_PER_CALL;
  const chain = mode === 'plan' ? PLAN_PROVIDER_CHAIN : SECTION_PROVIDER_CHAIN;

  try {
    const { text, finishReason, modelUsed, providerUsed } = await callWithFallback(chain, chatMessages, dynamicTokens, req.headers.origin);
    return res.status(200).json({ content: text, finishReason, modelUsed, providerUsed });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
}
