const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

// Configuration de l'URL du service de base de données et notification
console.log('DB_SERVICE_URL', process.env.DB_SERVICE_URL);
console.log('NOTIFICATION_SERVICE_URL', process.env.NOTIFICATION_SERVICE_URL);
const DB_SERVICE_URL = process.env.DB_SERVICE_URL;
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL;

// Plans d'abonnement (à configurer dans Stripe)
const SUBSCRIPTION_PLANS = {
  MONTHLY: process.env.STRIPE_MONTHLY_PLAN_ID,
  YEARLY: process.env.STRIPE_YEARLY_PLAN_ID
};

/**
 * Crée une session de paiement pour un abonnement
 */
const createSubscriptionSession = async (customerId, planType, userEmail, successUrl, cancelUrl) => {
  try {
    // Récupération de l'ID du plan
    const planId = SUBSCRIPTION_PLANS[planType.toUpperCase()];
    
    if (!planId) {
      throw new Error(`Plan d'abonnement non valide: ${planType}`);
    }
    
    // Création d'un client Stripe s'il n'existe pas déjà
    let customer;
    if (!customerId) {
      customer = await stripe.customers.create({
        email: userEmail,
        metadata: {
          userId: userEmail // Peut être remplacé par un ID utilisateur
        }
      });
      customerId = customer.id;
    }
    
    // Création de la session de paiement
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: planId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    
    return {
      customerId,
      sessionId: session.id,
      url: session.url
    };
  } catch (error) {
    console.error('Erreur lors de la création de la session d\'abonnement:', error);
    throw error;
  }
};

/**
 * Vérifie le statut d'un abonnement
 */
const checkSubscriptionStatus = async (subscriptionId) => {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return {
      status: subscription.status,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end
    };
  } catch (error) {
    console.error('Erreur lors de la vérification du statut d\'abonnement:', error);
    throw error;
  }
};

/**
 * Gère les webhooks Stripe
 */
const handleWebhookEvent = async (event) => {
  try {
    console.log(`🔄 handleWebhookEvent - Début du traitement de l'événement ${event.type}`);
    console.log(`🔍 Détails de l'événement: ID=${event.id}, Type=${event.type}`);
    
    switch (event.type) {
      case 'checkout.session.completed':
        console.log('📝 Traitement de checkout.session.completed');
        await handleCheckoutSessionCompleted(event.data.object);
        break;
      case 'invoice.paid':
        console.log('📝 Traitement de invoice.paid');
        await handleInvoicePaid(event.data.object);
        break;
      case 'invoice.payment_failed':
        console.log('📝 Traitement de invoice.payment_failed');
        await handlePaymentFailed(event.data.object);
        break;
      case 'customer.subscription.updated':
        console.log('📝 Traitement de customer.subscription.updated');
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        console.log('📝 Traitement de customer.subscription.deleted');
        await handleSubscriptionDeleted(event.data.object);
        break;
      default:
        console.log(`Événement non géré: ${event.type}`);
    }
    console.log(`✅ handleWebhookEvent - Traitement de l'événement ${event.type} terminé avec succès`);
    return true;
  } catch (error) {
    console.error(`❌ ERROR dans handleWebhookEvent pour ${event.type}:`, error.message);
    console.error('Stack trace:', error.stack);
    throw error;
  }
};

/**
 * Gère la complétion d'une session de paiement
 */
const handleCheckoutSessionCompleted = async (session) => {
  try {
    console.log(`🔄 handleCheckoutSessionCompleted - Début du traitement - Session ID: ${session.id}`);
    // Récupérer les détails du client
    let userEmail, userId, customer, subscription;
    
    // Vérifier si c'est un test avec _customerMock
    if (session._customerMock && session._customerMock.email) {
      console.log(`🧪 Mode test détecté avec email: ${session._customerMock.email}`);
      userEmail = session._customerMock.email;
    } else {
      // En production, récupérer depuis Stripe
      console.log(`🔍 Récupération du customer Stripe: ${session.customer}`);
      customer = await stripe.customers.retrieve(session.customer);
      userEmail = customer.email;
      console.log(`✅ Email récupéré depuis Stripe: ${userEmail}`);
    }
    
    // Récupérer l'ID de l'utilisateur depuis la base de données
    try {
      console.log(`🔍 Récupération de l'utilisateur depuis la BDD pour ${userEmail}`);
      const userResponse = await axios.get(`${DB_SERVICE_URL}/api/users/email/${userEmail}`);
      userId = userResponse.data.id;
      console.log(`✅ ID utilisateur récupéré: ${userId}`);
    } catch (error) {
      console.error(`❌ Erreur lors de la récupération de l'utilisateur:`, error.message);
      throw error;
    }
    
    // Récupérer les détails de l'abonnement depuis Stripe ou des données mockées
    try {
      if (session._subscriptionMock) {
        // Utiliser les données mockées pour les tests
        console.log(`🧪 Utilisation des données d'abonnement mockées pour les tests`);
        subscription = session._subscriptionMock;
      } else {
        console.log(`🔍 Récupération des détails de l'abonnement Stripe: ${session.subscription}`);
        subscription = await stripe.subscriptions.retrieve(session.subscription, {
          expand: ['items.data.price.product']
        });
      }
      console.log(`✅ Détails de l'abonnement récupérés`);
      
      // Calculer la date de fin
      const endDate = new Date(subscription.current_period_end * 1000);
      console.log(`📅 Date de fin d'abonnement: ${endDate.toISOString()}`);
      
      // Créer l'entrée d'abonnement dans la BDD
      const subscriptionData = {
        userId: userId,
        planType: subscription.items?.data[0]?.price?.product?.name || 'Service Premium',
        startDate: new Date(subscription.current_period_start * 1000),
        endDate: endDate,
        status: subscription.status,
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: subscription.customer,
        isActive: subscription.status === 'active',
        autoRenew: !subscription.cancel_at_period_end,
        lastPaymentDate: new Date(),
        nextPaymentDate: endDate,
        amount: (subscription.items?.data[0]?.price?.unit_amount) / 100,
        currency: subscription.currency || 'eur'
      };
      
      console.log(`🔄 Création de l'abonnement dans la BDD:`, JSON.stringify(subscriptionData, null, 2));
      let subscriptionId;
      try {
        // S'assurer que l'URL est correcte
        const subscriptionsUrl = `${DB_SERVICE_URL}/api/subscriptions`;
        console.log(`📌 URL d'envoi: ${subscriptionsUrl}`);
        
        const subscriptionResponse = await axios.post(subscriptionsUrl, subscriptionData);
        console.log(`✅ Abonnement créé ou mis à jour en BDD avec l'ID: ${subscriptionResponse.data.id}`);
        subscriptionId = subscriptionResponse.data.id;
        
      } catch (subscriptionError) {
        console.error(`❌ Erreur lors de la création de l'abonnement dans la BDD:`, subscriptionError.message);
        if (subscriptionError.response) {
          console.error(`📋 Réponse de la BDD:`, subscriptionError.response.data);
          console.error(`📋 Status code:`, subscriptionError.response.status);
        }
        // Faire un test d'accessibilité du service BDD
        try {
          console.log(`🔍 Test d'accessibilité du service BDD: ${DB_SERVICE_URL}/health`);
          const healthResponse = await axios.get(`${DB_SERVICE_URL}/health`);
          console.log(`🏥 Service BDD accessible:`, healthResponse.data);
        } catch (healthError) {
          console.error(`💀 Service BDD inaccessible:`, healthError.message);
        }
      }
    } catch (stripeError) {
      console.error(`❌ Erreur lors de la récupération des détails Stripe:`, stripeError.message);
    }
    
    // Mettre à jour le statut d'abonnement de l'utilisateur directement sans passer par updateUserSubscriptionStatus
    console.log(`🔄 Mise à jour directe du statut d'abonnement pour ${userEmail}`);
    try {
      // Mise à jour de l'utilisateur via l'API du service de BDD
      const userResponse = await axios.get(`${DB_SERVICE_URL}/api/users/email/${userEmail}`);
      const userId = userResponse.data.id;
      
      await axios.put(`${DB_SERVICE_URL}/api/users/subscription/${userEmail}`, {
        isSubscribed: true,
        subscriptionId: session.subscription,
        numSubscriptionId: subscriptionId,
        subscriptionEndDate: session.current_period_end ? new Date(session.current_period_end * 1000).toISOString() : null
      });
      
      console.log(`✅ Statut d'abonnement mis à jour pour ${userEmail} (isSubscribed=true)`);
    } catch (updateError) {
      console.error(`❌ Erreur lors de la mise à jour du statut d'abonnement:`, updateError.message);
      // Ne pas arrêter le processus en cas d'erreur
    }
    
    // Envoyer une notification à l'utilisateur
    console.log(`🔔 Envoi de notification 'new' à ${userEmail}`);
    try {
      // Envoyer une seule notification via l'endpoint spécifique
      console.log(`📨 Utilisation de l'endpoint notification/subscription/start`);
      await sendSubscriptionNotification(userEmail, 'new', {
        checkoutCompleted: true, 
        subscriptionId: session.subscription,
        planType: subscription?.items?.data[0]?.price?.product?.name || 'Premium',
        startDate: subscription?.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : new Date().toISOString(),
        endDate: subscription?.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : new Date(Date.now() + 30*24*60*60*1000).toISOString()
      });
      console.log(`✅ Notification envoyée avec succès à ${userEmail}`);
    } catch (notificationError) {
      // Ne pas bloquer le processus si la notification échoue
      console.warn(`⚠️ Erreur lors de l'envoi de la notification:`, notificationError.message);
    }
    
    console.log(`✅ handleCheckoutSessionCompleted - Abonnement activé pour ${userEmail}`);
  } catch (error) {
    console.error('❌ ERROR dans handleCheckoutSessionCompleted:', error.message);
    console.error('Stack trace:', error.stack);
    throw error;
  }
};

/**
 * Gère le paiement réussi d'une facture
 */
const handleInvoicePaid = async (invoice) => {
  try {
    console.log(`🔄 handleInvoicePaid - Début du traitement - Facture ID: ${invoice.id}`);
    const subscriptionId = invoice.subscription;
    
    // Vérifier si l'ID de l'abonnement est présent
    if (!subscriptionId) {
      console.log('Facture sans abonnement associé, ignorée.');
      return;
    }
    
    console.log(`🔍 Récupération de l'abonnement Stripe: ${subscriptionId}`);
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    
    // Mettre à jour le statut dans la BDD
    console.log(`🔄 Mise à jour du statut de l'abonnement dans la BDD: ${subscriptionId}`);
    await updateUserSubscriptionStatus(invoice.customer_email, true, subscriptionId);
    
    // Mise à jour de la date de fin
    const endDate = new Date(subscription.current_period_end * 1000);
    console.log(`📅 Mise à jour de la date de fin d'abonnement: ${endDate.toISOString()}`);
    await updateUserSubscriptionEnd(invoice.customer_email, endDate);
    
    // Envoyer une notification de renouvellement
    console.log(`🔔 Envoi de notification 'renewed' à ${invoice.customer_email}`);
    await sendSubscriptionNotification(invoice.customer_email, 'renewed', {
      subscriptionId,
      endDate: endDate.toISOString()
    });
    
  } catch (error) {
    console.error('Erreur lors du traitement de invoice.paid:', error);
    // Ne pas relancer pour éviter que Stripe ne renvoie le webhook
  }
};

/**
 * Gère l'échec de paiement d'une facture
 */
const handlePaymentFailed = async (invoice) => {
  try {
    console.log('🔄 handlePaymentFailed - Traitement du paiement échoué');
    await sendSubscriptionNotification(invoice.customer_email, 'payment_failed', {
      invoiceId: invoice.id,
      amountDue: (invoice.amount_due / 100).toFixed(2),
      currency: invoice.currency
    });
  } catch (error) {
    console.error('Erreur lors du traitement de payment_failed:', error);
    // Ne pas relancer pour éviter de bloquer les autres webhooks
  }
};

/**
 * Gère la mise à jour d'un abonnement
 */
const handleSubscriptionUpdated = async (subscription) => {
  try {
    console.log(`🔄 handleSubscriptionUpdated - Traitement de la mise à jour de l'abonnement: ${subscription.id}`);
    const customer = await stripe.customers.retrieve(subscription.customer);
    
    // 1. Récupérer l'abonnement de notre BDD via l'ID de l'abonnement Stripe
    const bddSubscriptionResponse = await axios.get(`${DB_SERVICE_URL}/api/subscriptions/stripe/${subscription.id}`);
    const bddSubscription = bddSubscriptionResponse.data;

    if (!bddSubscription) {
      console.error(`❌ Erreur: Abonnement Stripe ${subscription.id} non trouvé dans notre BDD.`);
      return;
    }

    // 2. Préparer les données de mise à jour
    const subscriptionData = {
      status: subscription.status,
      isActive: subscription.status === 'active',
      autoRenew: !subscription.cancel_at_period_end,
      endDate: new Date((subscription.cancel_at || subscription.current_period_end) * 1000)
    };
    
    // 3. Mettre à jour l'abonnement dans notre BDD en utilisant son ID interne (UUID) et la méthode PATCH
    await axios.patch(`${DB_SERVICE_URL}/api/subscriptions/${bddSubscription.internalId}`, subscriptionData);

    // Mettre à jour le statut de l'utilisateur pour l'annulation immédiate
    if (subscription.cancel_at_period_end) {
      await updateUserSubscriptionStatus(customer.email, false, subscription.id);
    }
    
    // Envoyer la notification appropriée
    if (subscription.cancel_at_period_end) {
      await sendSubscriptionNotification(customer.email, 'cancelled', {
        subscriptionId: subscription.id,
        endDate: new Date(subscription.cancel_at * 1000).toISOString()
      });
    } else {
      await sendSubscriptionNotification(customer.email, 'updated', {
        subscriptionId: subscription.id,
        newStatus: subscription.status
      });
    }

  } catch (error) {
    console.error('Erreur lors du traitement de subscription.updated:', error);
  }
};

/**
 * Gère la suppression d'un abonnement
 * (quand il arrive VRAIMENT à son terme)
 */
const handleSubscriptionDeleted = async (subscription) => {
  try {
    console.log(`🔄 handleSubscriptionDeleted - Traitement de la suppression de l'abonnement: ${subscription.id}`);
    
    // 1. Récupérer l'abonnement de notre BDD via l'ID de l'abonnement Stripe
    const bddSubscriptionResponse = await axios.get(`${DB_SERVICE_URL}/api/subscriptions/stripe/${subscription.id}`);
    const bddSubscription = bddSubscriptionResponse.data;

    if (!bddSubscription) {
      console.error(`❌ Erreur: Abonnement Stripe ${subscription.id} non trouvé dans notre BDD.`);
      return;
    }

    const customer = await stripe.customers.retrieve(subscription.customer);

    // 2. Mettre à jour le statut dans la BDD
    await axios.put(`${DB_SERVICE_URL}/api/subscriptions/${bddSubscription.id}`, {
      status: 'deleted',
      isActive: false
    });

    // 3. Mettre à jour le statut de l'utilisateur
    await updateUserSubscriptionStatus(customer.email, false, null);
    
  } catch (error) {
    console.error('Erreur lors du traitement de subscription.deleted:', error);
  }
};

/**
 * Met à jour le statut de l'abonnement dans le service de base de données
 */
const updateUserSubscriptionStatus = async (userEmail, isSubscribed, subscriptionId = null) => {
  try {
    console.log(`🔄 Mise à jour du statut d'abonnement pour ${userEmail}: isSubscribed=${isSubscribed}`);
    
    // Utiliser la route correcte: /api/users/subscription/:email
    await axios.put(`${DB_SERVICE_URL}/api/users/subscription/${userEmail}`, {
      isSubscribed,
      stripeSubscriptionId: subscriptionId
    });
    
    console.log(`✅ Statut d'abonnement mis à jour pour ${userEmail}`);
  } catch (error) {
    console.error('❌ Erreur lors de la mise à jour du statut de l\'abonnement:', error.response?.data || error.message);
    throw error;
  }
};

/**
 * Met à jour la date de fin de l'abonnement dans le service de base de données
 */
const updateUserSubscriptionEnd = async (email, subscriptionEndDate) => {
  try {
    console.log(`📅 Mise à jour de la date de fin d'abonnement pour ${email}`);
    
    // Utiliser la route correcte: /api/users/subscription/:email
    await axios.put(`${DB_SERVICE_URL}/api/users/subscription/${email}`, {
      subscriptionEndDate: subscriptionEndDate.toISOString()
    });
    
    console.log(`✅ Date de fin mise à jour pour ${email}`);
  } catch (error) {
    console.error('❌ Erreur lors de la mise à jour de la date de fin d\'abonnement:', error.response?.data || error.message);
    throw error;
  }
};

/**
 * Envoie une notification à l'utilisateur concernant son abonnement
 */
const sendSubscriptionNotification = async (email, type, data = {}) => {
  try {
    console.log(`🔔 Tentative d'envoi de la notification de type '${type}' à ${email}`);
    let retries = 3;
    let delay = 1000;
    
    // Définir les endpoints pour chaque type de notification
    const endpoints = {
      'new': '/notifications/subscription/start',
      'renewed': '/notifications/subscription/renewed',
      'cancelled': '/notifications/subscription/cancelled',
      'payment_failed': '/notifications/subscription/payment-failed',
      'updated': '/notifications/subscription/updated'
    };
    
    const endpoint = endpoints[type];
    
    if (!endpoint) {
      console.error(`❌ Type de notification non reconnu: ${type}`);
      return;
    }

    const attemptSend = async () => {
      try {
        await axios.post(`${NOTIFICATION_SERVICE_URL}${endpoint}`, {
          email: email,
          subscriptionData: data
        });
        console.log(`✅ Notification de type '${type}' envoyée avec succès à ${email}`);
      } catch (error) {
        if (retries > 0) {
          retries--;
          console.warn(`⚠️ Échec de l'envoi, nouvelle tentative dans ${delay / 1000}s... (${retries} tentatives restantes)`);
          await new Promise(res => setTimeout(res, delay));
          delay *= 2; // Augmenter le délai (backoff exponentiel)
          await attemptSend();
        } else {
          console.error(`❌ Échec de l'envoi de la notification de type '${type}' après plusieurs tentatives:`, error.response?.data || error.message);
          throw error; // Propager l'erreur après l'échec final
        }
      }
    };
    
    await attemptSend();
  } catch (error) {
    // Erreur déjà loguée dans attemptSend
    console.error(`❌ Erreur finale lors de l'envoi de la notification à ${email}`);
  }
};

/**
 * Envoie un email de facture via le service de notification
 */
const sendInvoiceEmail = async (email, invoice) => {
  try {
    console.log(`📧 Tentative d'envoi de l'email de facture à ${email}`);
    
    await axios.post(`${NOTIFICATION_SERVICE_URL}/notifications/invoice`, {
      to: email,
      invoice: {
        id: invoice.id,
        amount_paid: invoice.amount_paid / 100,
        currency: invoice.currency,
        created: new Date(invoice.created * 1000).toLocaleDateString(),
        pdf_url: invoice.invoice_pdf
      }
    });
    
    console.log(`✅ Email de facture envoyé à ${email}`);
  } catch (error) {
    console.error('❌ Erreur lors de l\'envoi de l\'email de facture:', error.response?.data || error.message);
    // Ne pas relancer l'erreur pour ne pas bloquer les autres webhooks
  }
};

module.exports = {
  createSubscriptionSession,
  checkSubscriptionStatus,
  handleWebhookEvent,
  // Fonctions exportées pour les tests
  handleCheckoutSessionCompleted,
  handleInvoicePaid,
  handlePaymentFailed,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  updateUserSubscriptionStatus,
  updateUserSubscriptionEnd,
  sendSubscriptionNotification,
  sendInvoiceEmail
};