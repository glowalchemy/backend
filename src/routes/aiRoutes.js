const express = require('express');
const axios = require('axios');
const { authenticateAdmin, requireAdmin } = require('../middleware/adminAuth');
const { openaiApiKey } = require('../config');

const router = express.Router();

// Server-side OpenAI proxy. The admin frontend never sees or stores an API key.
// Returns 501 if OPENAI_API_KEY is not configured so the UI can degrade gracefully.
router.post('/improve-description', authenticateAdmin, requireAdmin, async (req, res) => {
  try {
    const { originalDescription, productName, category } = req.body || {};

    if (!originalDescription || !originalDescription.trim()) {
      return res.status(400).json({ success: false, message: 'originalDescription is required' });
    }

    if (!openaiApiKey) {
      return res.status(501).json({
        success: false,
        message: 'AI improvements are not configured. Set OPENAI_API_KEY on the server.',
      });
    }

    const prompt = `Improve the following product description to make it more professional, engaging, and persuasive.

Product Name: ${productName || ''}
Category: ${category || ''}
Original Description: ${originalDescription}

Please enhance the description by:
1. Making it more engaging and professional
2. Improving grammar and readability
3. Adding persuasive language that highlights benefits
4. Keeping it concise but comprehensive
5. Maintaining accuracy to the original product
6. Using marketing-friendly language

Return only the improved description without any additional text or explanations.`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content:
              'You are a professional copywriter specializing in e-commerce product descriptions. Your task is to improve product descriptions to make them more appealing and professional.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300,
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const improved = response.data?.choices?.[0]?.message?.content?.trim();
    if (!improved) {
      return res.status(502).json({ success: false, message: 'AI returned an empty response' });
    }

    return res.json({ success: true, improvedDescription: improved });
  } catch (err) {
    console.error('AI improve-description failed:', err.message);
    const status = err.response?.status || 502;
    return res.status(status).json({ success: false, message: 'AI improvement failed' });
  }
});

module.exports = router;
