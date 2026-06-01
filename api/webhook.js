// api/webhook.js — Stripe webhook: activates Pro when payment succeeds

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
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
