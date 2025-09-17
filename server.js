const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const createStripeRoutes = require('./routes');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const promBundle = require('express-prom-bundle');



dotenv.config();

// Afficher les variables d'environnement importantes (masquées pour les secrets)
console.log('\n🔰 DÉMARRAGE DU SERVICE DE PAIEMENT 🔰');
console.log('=== Configuration du service de paiement ===');
console.log('PORT:', process.env.PORT || 3002);
console.log('STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY ? 'Configuré (valeur masquée)' : 'Non configuré ⚠️');
console.log('STRIPE_WEBHOOK_SECRET:', process.env.STRIPE_WEBHOOK_SECRET ? 'Configuré (valeur masquée)' : 'Non configuré ⚠️');
console.log('NOTIFICATION_SERVICE_URL:', process.env.NOTIFICATION_SERVICE_URL);
console.log('DB_SERVICE_URL:', process.env.DB_SERVICE_URL);
console.log('CLIENT_URL:', process.env.CLIENT_URL);
console.log('MODE:', process.env.NODE_ENV || 'development');
console.log('=======================================');

// Importation de la fonction de création des plans Stripe
const createStripePlans = require('./controllers/create-stripe-plans');

// Initialiser Stripe
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const stripeService = require('./controllers/stripeService')(stripe); // Injecter Stripe dans le service

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(cors());

// Configuration pour le webhook Stripe - doit être AVANT express.json()
// pour conserver le body brut pour la vérification de signature Stripe
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  console.log('\n🚨 ======= WEBHOOK STRIPE REÇU =======');
  console.log('📩 URL:', req.url);
  console.log('📩 Method:', req.method);
  console.log('📩 Timestamp:', new Date().toISOString());
  console.log('🔍 Headers du webhook:', JSON.stringify(req.headers, null, 2));
  console.log('🔍 Type de corps:', typeof req.body, Buffer.isBuffer(req.body) ? '(Buffer)' : '');
  console.log('🔍 Taille du corps:', req.body ? req.body.length : 0);
  if (req.headers['stripe-signature']) {
    console.log('✅ Stripe signature présente:', req.headers['stripe-signature'].substring(0, 50) + '...');
  } else {
    console.log('⚠️ Pas de signature Stripe trouvée!');
  }
  console.log('======================================\n');
  next();
});

// Middleware pour parser le JSON pour toutes les autres routes
app.use(express.json());

// Middleware Prometheus pour collecter les métriques HTTP
const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  includeStatusCode: true,
  includeUp: true,
  customLabels: { project_name: 'payment-service' }, // Remplacer par le nom du service
  promClient: { collectDefaultMetrics: {} }
});
app.use(metricsMiddleware);

// Vérifier et créer les plans Stripe si nécessaire
async function initializeStripe() {
  try {
    console.log('⚡ Initialisation de Stripe et création des plans...');
    
    // Forcer la création des plans, peu importe les configurations précédentes
    const plans = await createStripePlans(true);
    console.log(`✅ Plans Stripe créés avec succès ! Mensuel: ${plans.monthlyPriceId}, Annuel: ${plans.yearlyPriceId}`);
    
    // Recharger les variables d'environnement
    dotenv.config();
    
    return plans;
  } catch (error) {
    console.error('❌ Erreur lors de l\'initialisation des plans Stripe:', error);
    throw error;
  }
}

// Route de santé
app.get('/health', (req, res) => {
  console.log('🏥 Vérification de santé du service de paiement');
  res.json({ 
    status: 'OK', 
    message: 'Service de paiement opérationnel',
    notification_service: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3006',
    db_service: process.env.DB_SERVICE_URL || 'http://localhost:3004',
    timestamp: new Date().toISOString()
  });
});

// Créer et utiliser les routes en injectant les dépendances
const paymentRoutes = createStripeRoutes(stripe, stripeService);
app.use('/api/payments', paymentRoutes);

// Route pour exposer les métriques Prometheus
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.end(promBundle.promClient.register.metrics());
});

// Initialiser Stripe et démarrer le serveur
initializeStripe().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Le service de paiement écoute sur le port ${PORT}`);
    
    // Tester la connexion au service de base de données
    const dbUrl = process.env.DB_SERVICE_URL || 'http://localhost:3004';
    console.log(`\n🔄 Test de connexion au service de base de données: ${dbUrl}/api/health`);
    
    axios.get(`${dbUrl}/api/health`)
      .then(response => {
        console.log('✅ Service de base de données accessible:', response.data);
        console.log('🔍 Test de la route /subscriptions...');
        
        // Tester si la route /subscriptions existe en faisant une requête HEAD
        return axios.head(`${dbUrl}/api/subscriptions/`).catch(err => {
          if (err.response && (err.response.status === 404 || err.response.status === 405)) {
            console.log('✅ La route /subscriptions est accessible');
          } else {
            console.log('⚠️ Impossible de tester la route /subscriptions, mais le service BDD fonctionne');
          }
        });
      })
      .catch(error => console.error('❌ Service de base de données inaccessible:', error.message));
    
    // Tester la connexion au service de notification
    const notificationUrl = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3006';
    console.log(`\n🔄 Test de connexion au service de notification: ${notificationUrl}/health`);
    
    axios.get(`${notificationUrl}/health`)
      .then(response => console.log('✅ Service de notification accessible:', response.data))
      .catch(error => console.error('❌ Service de notification inaccessible:', error.message));
      
    console.log('\n⚠️ IMPORTANT: Assurez-vous que Stripe est configuré pour envoyer des webhooks à:');
    console.log(`🔗 http://localhost:${PORT}/api/payments/webhook`);
    console.log('📋 Événements à activer: checkout.session.completed, invoice.paid, customer.subscription.updated\n');
  });
}).catch(err => {
  console.error('Erreur au démarrage du serveur:', err);
});