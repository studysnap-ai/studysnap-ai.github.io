// api/subscribe.js — Creates a Stripe checkout session for Pro upgrade

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid token.' });

    const user = data.user;

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: user.email,
      line_items: [
        {
          price: process.env.STRIPE_PRO_PRICE_ID, // set in Vercel env
          quantity: 1,
        },
      ],
      success_url: `https://studysnap-ai.github.io?upgraded=true`,
      cancel_url:  `https://studysnap-ai.github.io?upgraded=false`,
      metadata: {
        user_id: user.id,
      },
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('[StudySnap API] subscribe error:', err);
    return res.status(500).json({ error: 'Could not start checkout.' });
  }
}
