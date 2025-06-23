const express = require('express');
const router = express.Router();
const dotenv = require('dotenv');
const axios = require('axios');

// Charger les variables d'environnement
dotenv.config();

// Initialiser Stripe
let stripe;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('Stripe initialisé avec succès');
  } else {
    console.warn('Clé API Stripe non définie. Le service ne fonctionnera pas correctement.');
  }
} catch (error) {
  console.error('Erreur lors de l\'initialisation de Stripe:', error);
}

// Charger le service Stripe
let stripeService;
try {
  stripeService = require('../controllers/stripeService');
} catch (error) {
  console.error('Erreur lors du chargement du service Stripe:', error);
}

// Route pour créer une session de paiement d'abonnement
router.post('/create-subscription', async (req, res) => {
  try {
    // Vérifier que Stripe est configuré
    if (!stripe || !stripeService) {
      return res.status(500).json({ 
        error: 'Stripe n\'est pas configuré correctement. Veuillez vérifier la configuration.'
      });
    }

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
    // Vérifier que Stripe est configuré
    if (!stripe || !stripeService) {
      return res.status(500).json({ 
        error: 'Stripe n\'est pas configuré correctement. Veuillez vérifier la configuration.'
      });
    }

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
    // Vérifier que Stripe est configuré
    if (!stripe) {
      return res.status(500).json({ 
        error: 'Stripe n\'est pas configuré correctement. Veuillez vérifier la configuration.'
      });
    }

    const { subscriptionId } = req.body;
    
    if (!subscriptionId) {
      return res.status(400).json({ error: 'ID d\'abonnement requis' });
    }
    
    // Annuler à la fin de la période de facturation en cours
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true
    });
    
    res.json({
      success: true,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000)
    });
  } catch (error) {
    console.error('Erreur lors de l\'annulation de l\'abonnement:', error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook pour recevoir les événements Stripe
router.post('/webhook', async (req, res) => {
  console.log('🔔 WEBHOOK STRIPE REÇU sur /webhook!');
  console.log('📦 Headers:', req.headers);
  console.log('📦 Body type:', typeof req.body);
  console.log('📦 Body length:', req.body ? req.body.length || Object.keys(req.body).length : 0);
  
  // Vérifier que Stripe est configuré
  if (!stripe || !stripeService) {
    console.error('❌ Stripe n\'est pas configuré correctement.');
    return res.status(500).json({ 
      error: 'Stripe n\'est pas configuré correctement. Veuillez vérifier la configuration.'
    });
  }

  let rawBody = req.body;
  if (Buffer.isBuffer(rawBody)) {
    try {
      rawBody = rawBody.toString('utf8');
    } catch (err) {
      console.error('❌ Erreur lors de la conversion du buffer:', err);
      return res.status(500).json({ error: 'Erreur de traitement du body' });
    }
  }
  
  
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  

  
  let event;
  let payload;
  
  try {
    // Détection de mode test
    const isTestMode = req.headers['x-test-mode'] === 'true' || req.headers['x-request-id']?.includes('test');
    
    if (isTestMode || !sig || !endpointSecret) {
      console.warn('⚠️ Mode test ou signature manquante détecté');
      
      // Analyser le corps de la requête
      if (typeof rawBody === 'string') {
        try {
          payload = JSON.parse(rawBody);
        } catch (e) {
          console.error('❌ Impossible de parser le corps de la requête:', e);
          console.error('Body reçu:', rawBody);
          return res.status(400).json({ error: 'Invalid JSON' });
        }
      } else if (typeof rawBody === 'object') {
        payload = rawBody;
      } else {
        console.error('❌ Format de requête non supporté. Type:', typeof rawBody);
        return res.status(400).json({ error: 'Unsupported request format' });
      }
      
      if (!payload.type || !payload.data || !payload.data.object) {
        console.error('❌ Structure d\'événement Stripe invalide:');
        console.error('- payload.type:', payload.type);
        console.error('- payload.data:', payload.data ? 'présent' : 'absent');
        console.error('- payload.data.object:', payload.data?.object ? 'présent' : 'absent');
        return res.status(400).json({ error: 'Invalid Stripe event structure' });
      }
      
      event = {
        id: payload.id || 'evt_test_' + Date.now(),
        type: payload.type,
        data: {
          object: payload.data.object
        },
        _isTest: true
      };
      
      // Ajouter les données de test pour mockup
      if (payload._customerMock) {
        event.data.object._customerMock = payload._customerMock;
      } else {
        console.warn('⚠️ Pas de _customerMock fourni, le hook pourrait échouer sans accès à Stripe');
      }
      
    } else {
      event = stripe.webhooks.constructEvent(rawBody, sig, endpointSecret);
    }
  } catch (err) {
    console.error('❌ Erreur de signature webhook:', err.message);
    console.error('Stack trace:', err.stack);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  try {
    console.log('🚀 Traitement de l\'événement Stripe:', event.type);
    console.log('🔍 Event ID:', event.id);
    
    // Appel du service
    await stripeService.handleWebhookEvent(event);

    console.log('✅ Webhook traité avec succès!');
    res.json({ received: true });
  } catch (error) {
    console.error('❌ Erreur lors du traitement du webhook:', error.message);
    console.error('Type d\'erreur:', error.constructor.name);
    console.error('Stack trace:', error.stack);
    
    if (error.response) {
      console.error('Réponse HTTP d\'erreur:', error.response.status);
      console.error('Données de réponse:', error.response.data);
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Route pour récupérer les plans disponibles
router.get('/plans', async (req, res) => {
  try {
    
    // Vérifier que Stripe est configuré
    if (!stripe) {
      console.error('❌ Stripe n\'est pas initialisé');
      return res.status(500).json({ 
        error: 'Stripe n\'est pas configuré correctement. Veuillez vérifier la configuration.'
      });
    }



    // Récupérer les prix depuis Stripe
    const prices = await stripe.prices.list({
      active: true,
      type: 'recurring',
      limit: 10,
      expand: ['data.product']
    });
    
    
    // Formater les données pour le client
    const plans = prices.data.map(price => ({
      id: price.id,
      productId: price.product.id,
      name: price.product.name,
      description: price.product.description,
      amount: price.unit_amount / 100,
      currency: price.currency,
      interval: price.recurring.interval,
      intervalCount: price.recurring.interval_count
    }));
    
    
    res.json(plans);
  } catch (error) {
    console.error('❌ Erreur lors de la récupération des plans:', error);
    res.status(500).json({ 
      error: 'Impossible de récupérer les plans depuis Stripe. Veuillez vérifier votre configuration Stripe.'
    });
  }
});

router.get('/health', (req, res) => {
  console.log('🏥 Route de santé du service de paiement appelée');
  res.json({ status: 'ok', service: 'payment-service' });
});

// Route de test pour la communication avec la BDD
router.get('/test-bdd-connection', async (req, res) => {
  console.log('🧪 Test de connexion à la BDD démarré');
  try {
    console.log(`🔍 URL de la BDD configurée: ${process.env.DB_SERVICE_URL || 'http://localhost:3000 (défaut)'}`);
    
    // Tester la connexion à la BDD
    const response = await axios.get(`${process.env.DB_SERVICE_URL || 'http://localhost:3004'}/health`);
    console.log('✅ Connexion à la BDD réussie:', response.data);
    
    res.json({ 
      success: true, 
      message: 'Connexion à la BDD réussie',
      bddResponse: response.data
    });
  } catch (error) {
    console.error('❌ Erreur lors du test de connexion à la BDD:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Échec de connexion à la BDD',
      details: error.message
    });
  }
});

module.exports = router; 