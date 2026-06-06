// api/subscribe.js — Creates a Stripe checkout session for Pro upgrade

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
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

    // Check if user has an earned referral discount ($1 off first month)
    const { data: couponId } = await supabase.rpc('get_pending_referral_coupon', {
      p_user_id: user.id,
    });

    const sessionParams = {
      mode:                 'subscription',
      payment_method_types: ['card'],
      customer_email:       user.email,
      line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
      success_url: `https://trystudysnap.com?upgraded=true`,
      cancel_url:  `https://trystudysnap.com?upgraded=false`,
      metadata:    { user_id: user.id },
    };

    // Apply referral coupon — $1 off first month
    if (couponId) {
      sessionParams.discounts = [{ coupon: couponId }];
      console.log(`[StudySnap] Applying referral coupon ${couponId} for user ${user.id}`);
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ url: session.url, hasCoupon: Boolean(couponId) });

  } catch (err) {
    console.error('[StudySnap API] subscribe error:', err);
    return res.status(500).json({ error: 'Could not start checkout.' });
  }
}
