const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');

// Charger les variables d'environnement
dotenv.config();

function createStripeRoutes(stripe, stripeService) {
  const router = express.Router();

  // Route pour créer une session de paiement d'abonnement
  router.post('/create-subscription', async (req, res) => {
    try {
      // La vérification est maintenant implicite car les services sont injectés
      const { planType, email, customerId, successUrl, cancelUrl } = req.body;
      
      if (!planType || !email) {
        return res.status(400).json({ error: 'Type de plan et email requis' });
      }
      
      const session = await stripeService.createSubscriptionSession(
        customerId,
        planType,
        email,
        successUrl || `${process.env.CLIENT_URL || 'http://localhost:3000'}/subscription/success`,
        cancelUrl || `${process.env.CLIENT_URL || 'http://localhost:3000'}/subscription/cancel`
      );
      
      res.json(session);
    } catch (error) {
      console.error('Erreur lors de la création de la session de paiement:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Route pour vérifier le statut d'un abonnement
  router.get('/subscription/:id', async (req, res) => {
    try {
      const subscriptionId = req.params.id;
      const status = await stripeService.checkSubscriptionStatus(subscriptionId);
      res.json(status);
    } catch (error) {
      console.error('Erreur lors de la vérification du statut d\'abonnement:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Route pour annuler un abonnement
  router.post('/cancel-subscription', async (req, res) => {
    try {
      const { subscriptionId } = req.body;
      
      if (!subscriptionId) {
        return res.status(400).json({ error: 'ID d\'abonnement requis' });
      }
      
      const result = await stripeService.cancelSubscription(subscriptionId);
      
      res.json(result);
    } catch (error) {
      console.error('Erreur lors de l\'annulation de l\'abonnement:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Webhook pour recevoir les événements Stripe
  router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;

    try {
      const sig = req.headers['stripe-signature'];
      const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!sig || !endpointSecret) {
         console.warn("Signature du webhook ou secret manquant. Passage en mode de traitement non sécurisé.");
         event = req.body;
      } else {
         event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
      }
    } catch (err) {
      console.error('❌ Erreur de signature webhook:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    try {
      await stripeService.handleWebhookEvent(event);
      res.json({ received: true });
    } catch (error) {
      console.error('❌ Erreur lors du traitement du webhook:', error.message);
      res.status(500).json({ error: 'Erreur interne lors du traitement du webhook.' });
    }
  });

  // Route pour récupérer les plans disponibles
  router.get('/plans', async (req, res) => {
    try {
      const prices = await stripe.prices.list({
        active: true,
        type: 'recurring',
        limit: 10,
        expand: ['data.product']
      });
      
      const plans = prices.data.map(price => ({
        id: price.id,
        productId: price.product.id,
        name: price.product.name,
        description: price.product.description,
        amount: price.unit_amount / 100,
        currency: price.currency,
        interval: price.recurring.interval,
      }));
      
      res.json(plans);
    } catch (error) {
      console.error('Erreur lors de la récupération des plans:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = createStripeRoutes;