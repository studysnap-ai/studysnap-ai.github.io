// api/webhook.js — Stripe webhook: activates Pro when payment succeeds

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Vercel: disable body parsing so we can verify Stripe signature
export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig     = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId  = session.metadata?.user_id;
        if (!userId) break;

        const subscription = await stripe.subscriptions.retrieve(session.subscription);

        await supabase.from('subscriptions').upsert({
          user_id:                userId,
          stripe_customer_id:     session.customer,
          stripe_subscription_id: session.subscription,
          status:                 'active',
          period_end:             new Date(subscription.current_period_end * 1000).toISOString(),
        }, { onConflict: 'user_id' });

        console.log(`[StudySnap] Pro activated for user ${userId}`);

        // ── Referral conversion: check if this new Pro user was referred ──────
        const { data: referral } = await supabase
          .from('referrals')
          .select('referrer_id, converted_to_pro')
          .eq('referred_id', userId)
          .single();

        if (referral && !referral.converted_to_pro) {
          // Mark this referral as paid
          await supabase
            .from('referrals')
            .update({ converted_to_pro: true, converted_at: new Date().toISOString() })
            .eq('referred_id', userId);

          // Count how many paying referrals the referrer now has
          const { data: payingCount } = await supabase.rpc('get_paying_referral_count', {
            p_user_id: referral.referrer_id,
          });

          // Every 3 paying referrals = $1 off coupon for the referrer
          if (payingCount && payingCount % 3 === 0) {
            try {
              const coupon = await stripe.coupons.create({
                amount_off:      100, // $1 in cents
                currency:        'usd',
                duration:        'once',
                max_redemptions: 1,
                metadata:        { referrer_id: referral.referrer_id },
              });

              await supabase.from('referral_credits').insert({
                user_id:          referral.referrer_id,
                stripe_coupon_id: coupon.id,
              });

              console.log(`[StudySnap] $1 referral credit awarded to ${referral.referrer_id}`);
            } catch (couponErr) {
              console.error('[StudySnap] Failed to create referral coupon:', couponErr.message);
            }
          }
        }

        // ── Mark coupon as used if one was applied in this checkout ───────────
        const appliedCoupon = session.total_details?.breakdown?.discounts?.[0]?.discount?.coupon?.id;
        if (appliedCoupon) {
          await supabase.rpc('use_referral_credit', {
            p_user_id:   userId,
            p_coupon_id: appliedCoupon,
          });
        }

        break;
      }

      case 'customer.subscription.updated': {
        const sub    = event.data.object;
        const { data: existing } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_subscription_id', sub.id)
          .single();

        if (existing) {
          await supabase.from('subscriptions').update({
            status:     sub.status,
            period_end: new Date(sub.current_period_end * 1000).toISOString(),
          }).eq('stripe_subscription_id', sub.id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase.from('subscriptions')
          .update({ status: 'cancelled' })
          .eq('stripe_subscription_id', sub.id);
        console.log(`[StudySnap] Subscription cancelled: ${sub.id}`);
        break;
      }
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('[Stripe Webhook] Handler error:', err);
    return res.status(500).json({ error: 'Webhook handler failed.' });
  }
}
