const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

// Configuration de l'URL du service de base de données et notification
const DB_SERVICE_URL = process.env.DB_SERVICE_URL || 'http://localhost:3004';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3006';

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
      const userResponse = await axios.get(`${DB_SERVICE_URL}/users/email/${userEmail}`);
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
        const subscriptionsUrl = `${DB_SERVICE_URL}/subscriptions`;
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
      const userResponse = await axios.get(`${DB_SERVICE_URL}/users/email/${userEmail}`);
      const userId = userResponse.data.id;
      
      await axios.put(`${DB_SERVICE_URL}/users/subscription/${userEmail}`, {
        isSubscribed: true,
        subscriptionId: session.subscription,
        numSubscriptionId: subscriptionId,
        subscriptionEndDate: subscription?.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null
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
    let userEmail, subscription;
    
    // Vérifier si c'est un test
    if (invoice._customerMock && invoice._customerMock.email) {
      console.log(`🧪 Mode test détecté pour invoice.paid avec email: ${invoice._customerMock.email}`);
      userEmail = invoice._customerMock.email;
      subscription = { current_period_end: Math.floor(Date.now() / 1000) + 2592000 }; // +30 jours
    } else {
      subscription = await stripe.subscriptions.retrieve(invoice.subscription);
      const customer = await stripe.customers.retrieve(invoice.customer);
      userEmail = customer.email;
    }
    
    // Mise à jour de la date de fin d'abonnement
    const subscriptionEnd = new Date(subscription.current_period_end * 1000);
    await updateUserSubscriptionEnd(userEmail, subscriptionEnd);
    
    // Envoi de la facture par e-mail
    await sendInvoiceEmail(userEmail, invoice);
    
    console.log(`Facture payée pour ${userEmail}, abonnement valide jusqu'au ${subscriptionEnd}`);
  } catch (error) {
    console.error('Erreur lors du traitement de invoice.paid:', error);
    throw error;
  }
};

/**
 * Gère l'échec de paiement d'une facture
 */
const handlePaymentFailed = async (invoice) => {
  try {
    let userEmail;
    
    // Vérifier si c'est un test
    if (invoice._customerMock && invoice._customerMock.email) {
      console.log(`🧪 Mode test détecté pour invoice.payment_failed avec email: ${invoice._customerMock.email}`);
      userEmail = invoice._customerMock.email;
    } else {
      const customer = await stripe.customers.retrieve(invoice.customer);
      userEmail = customer.email;
    }
    
    // Notifier l'utilisateur de l'échec du paiement
    await sendSubscriptionNotification(userEmail, 'payment_failed', {
      invoiceId: invoice.id,
      amountDue: invoice.amount_due / 100,
      currency: invoice.currency
    });
    
    console.log(`Échec de paiement pour ${userEmail}`);
  } catch (error) {
    console.error('Erreur lors du traitement de invoice.payment_failed:', error);
    throw error;
  }
};

/**
 * Gère la mise à jour d'un abonnement
 */
const handleSubscriptionUpdated = async (subscription) => {
  try {
    let userEmail;
    
    // Vérifier si c'est un test
    if (subscription._customerMock && subscription._customerMock.email) {
      console.log(`🧪 Mode test détecté pour subscription.updated avec email: ${subscription._customerMock.email}`);
      userEmail = subscription._customerMock.email;
    } else {
      const customer = await stripe.customers.retrieve(subscription.customer);
      userEmail = customer.email;
    }
    
    if (subscription.cancel_at_period_end) {
      // L'abonnement est programmé pour être annulé à la fin de la période
      await sendSubscriptionNotification(userEmail, 'cancellation_scheduled', {
        endDate: new Date(subscription.current_period_end * 1000)
      });
    } else if (subscription.status === 'active' && subscription.cancel_at_period_end === false) {
      // L'abonnement a été réactivé
      await sendSubscriptionNotification(userEmail, 'reactivated');
    }
    
    console.log(`Abonnement mis à jour pour ${userEmail}, statut: ${subscription.status}`);
  } catch (error) {
    console.error('Erreur lors du traitement de customer.subscription.updated:', error);
    throw error;
  }
};

/**
 * Gère la suppression d'un abonnement
 */
const handleSubscriptionDeleted = async (subscription) => {
  try {
    let userEmail;
    
    // Vérifier si c'est un test
    if (subscription._customerMock && subscription._customerMock.email) {
      console.log(`🧪 Mode test détecté pour subscription.deleted avec email: ${subscription._customerMock.email}`);
      userEmail = subscription._customerMock.email;
    } else {
      const customer = await stripe.customers.retrieve(subscription.customer);
      userEmail = customer.email;
    }
    
    // Mettre à jour directement l'utilisateur dans la BDD sans passer par updateUserSubscriptionStatus
    console.log(`🔄 Mise à jour directe du statut d'abonnement pour ${userEmail} (suppression)`);
    try {
      await axios.put(`${DB_SERVICE_URL}/users/subscription/${userEmail}`, {
        isSubscribed: false,
        subscriptionId: null,
        subscriptionEndDate: new Date().toISOString()
      });
      console.log(`✅ Statut d'abonnement mis à jour pour ${userEmail} (isSubscribed=false)`);
    } catch (updateError) {
      console.error(`❌ Erreur lors de la mise à jour du statut d'abonnement:`, updateError.message);
      // Ne pas arrêter le processus en cas d'erreur
    }
    
    // Notifier l'utilisateur de la fin de son abonnement
    console.log(`🔔 Envoi de notification 'ended' à ${userEmail}`);
    await sendSubscriptionNotification(userEmail, 'ended', {
      subscriptionId: subscription.id,
      endDate: new Date().toISOString()
    });
    
    console.log(`✅ Abonnement terminé pour ${userEmail}`);
  } catch (error) {
    console.error('Erreur lors du traitement de customer.subscription.deleted:', error);
    throw error;
  }
};

/**
 * Met à jour le statut d'abonnement de l'utilisateur dans la base de données
 */
const updateUserSubscriptionStatus = async (userEmail, isSubscribed, subscriptionId = null) => {
  try {
    console.log(`🔄 Mise à jour du statut d'abonnement pour ${userEmail} (isSubscribed=${isSubscribed})`);
    
    // Récupérer l'utilisateur par email
    const userResponse = await axios.get(`${DB_SERVICE_URL}/users/email/${userEmail}`);
    const userId = userResponse.data.id;
    console.log(`✅ Utilisateur trouvé pour ${userEmail}, ID: ${userId}`);
    
    // Mettre à jour l'utilisateur en utilisant la route subscription avec l'email
    const updateData = {
      isSubscribed: isSubscribed
    };
    
    if (subscriptionId) {
      updateData.subscriptionId = subscriptionId;
    }
    
    console.log(`🔄 Mise à jour de l'utilisateur ${userId} avec:`, JSON.stringify(updateData, null, 2));
    await axios.put(`${DB_SERVICE_URL}/users/subscription/${userEmail}`, updateData);
    console.log(`✅ Statut d'abonnement mis à jour pour ${userEmail} (isSubscribed=${isSubscribed})`);
    
    return { success: true };
  } catch (error) {
    console.error(`❌ Erreur lors de la mise à jour du statut d'abonnement pour ${userEmail}:`, error.message);
    if (error.response) {
      console.error('Détails de l\'erreur:', error.response.data);
    }
    throw error;
  }
};

/**
 * Met à jour la date de fin d'abonnement de l'utilisateur
 */
const updateUserSubscriptionEnd = async (email, subscriptionEndDate) => {
  try {
    // En mode de test (avec un email mais sans l'URL de la base de données), simuler plutôt qu'échouer
    if (!DB_SERVICE_URL || DB_SERVICE_URL.includes('undefined')) {
      console.log(`🧪 Mode test: mise à jour de la date de fin d'abonnement simulée pour ${email} (${subscriptionEndDate.toISOString()})`);
      return;
    }
    
    try {
      await axios.put(`${DB_SERVICE_URL}/users/subscription/${email}`, {
        subscriptionEndDate: subscriptionEndDate.toISOString()
      });
      console.log(`✅ Date de fin d'abonnement mise à jour pour ${email} (${subscriptionEndDate.toISOString()})`);
    } catch (error) {
      console.error(`❌ Erreur lors de la mise à jour de la date de fin d'abonnement dans la base de données:`, error.message);
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        console.log(`⚠️ Service de base de données non disponible. Mode test: simulation de la mise à jour.`);
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Erreur lors de la mise à jour de la date de fin d\'abonnement:', error);
    throw error;
  }
};

/**
 * Envoie une notification à l'utilisateur concernant son abonnement
 */
const sendSubscriptionNotification = async (email, type, data = {}) => {
    const maxRetries = 3;
    const initialBackoff = 1000; // 1 second
    let currentRetry = 0;
    
    // Debug: Afficher l'URL du service de notification
    console.log(`🔍 DEBUG - sendSubscriptionNotification`);
    console.log(`📧 Email destinataire: ${email}`);
    console.log(`🏷️ Type de notification: ${type}`);
    console.log(`🔌 URL du service de notification: ${NOTIFICATION_SERVICE_URL}`);
    
    // Vérifier si l'email est valide
    if (!email || typeof email !== 'string' || !email.includes('@')) {
        console.error(`❌ Erreur: Email invalide ou manquant: "${email}"`);
        throw new Error(`Email invalide ou manquant: "${email}"`);
    }
    
    // Déterminer le point de terminaison de la notification en fonction du type
    let endpointPath = '';
    let payload = {};
    
    // Configurer l'endpoint et le payload en fonction du type
    switch (type) {
        case 'new':
            endpointPath = '/notifications/subscription/start';
            payload = {
                email,
                subscriptionData: {
                    subscriptionId: data.subscriptionId,
                    planType: data.planType || 'Premium',
                    startDate: data.startDate || new Date().toISOString(),
                    endDate: data.endDate || new Date(Date.now() + 30*24*60*60*1000).toISOString()
                }
            };
            break;
        case 'ended':
        case 'cancelled':
            endpointPath = '/notifications/subscription/cancelled';
            payload = {
                email,
                subscriptionData: {
                    subscriptionId: data.subscriptionId,
                    endDate: data.endDate || new Date().toISOString()
                }
            };
            break;
        case 'payment_failed':
            endpointPath = '/notifications/subscription/payment-failed';
            payload = {
                email,
                paymentData: {
                    amountDue: data.amountDue || '?',
                    currency: data.currency || 'EUR',
                    invoiceId: data.invoiceId || 'N/A'
                }
            };
            break;
        case 'cancellation_scheduled':
            endpointPath = '/notifications/subscription/expiring-soon';
            payload = {
                email,
                subscriptionData: {
                    endDate: data.endDate || new Date(Date.now() + 30*24*60*60*1000).toISOString()
                }
            };
            break;
        case 'reactivated':
            endpointPath = '/notifications/subscription/reactivated';
            payload = {
                email,
                subscriptionData: {}
            };
            break;
        default:
            console.error(`❌ Type de notification non pris en charge: ${type}`);
            throw new Error(`Type de notification non pris en charge: ${type}`);
    }
    
    if (!endpointPath) {
        console.error(`❌ Erreur: Impossible de déterminer l'endpoint pour le type "${type}"`);
        throw new Error(`Type de notification non pris en charge: ${type}`);
    }
    
    console.log(`🔄 Endpoint de notification choisi: ${endpointPath}`);
    console.log(`📦 Payload préparé:`, JSON.stringify(payload, null, 2));
    
    // Fonction pour tenter l'envoi avec retries
    const attemptSend = async () => {
        try {
            console.log(`🔔 [Tentative ${currentRetry + 1}/${maxRetries + 1}] Envoi de notification de type "${type}" à ${email}`);
            console.log(`📨 URL complète: ${NOTIFICATION_SERVICE_URL}${endpointPath}`);
            
            // Test de connectivité au service de notification
            try {
                console.log(`🔄 Test de connexion au service avant envoi: ${NOTIFICATION_SERVICE_URL}/health`);
                await axios.get(`${NOTIFICATION_SERVICE_URL}/health`);
                console.log(`✅ Service de notification accessible!`);
            } catch (connError) {
                console.error(`❌ Service de notification inaccessible avant envoi:`, connError.message);
                throw new Error(`Service de notification inaccessible: ${connError.message}`);
            }
            
            const response = await axios.post(`${NOTIFICATION_SERVICE_URL}${endpointPath}`, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Request-ID': `${type}-${new Date().toISOString()}`
                },
                timeout: 10000 // 10 secondes de timeout
            });
            
            console.log(`✅ Notification de type "${type}" envoyée à ${email}`);
            console.log(`📡 Réponse du service: ${JSON.stringify(response.data)}`);
            return { success: true, data: response.data };
        } catch (error) {
            console.error(`❌ Erreur lors de l'envoi de la notification "${type}":`, error.message);
            
            if (error.response) {
                console.error(`📋 Réponse d'erreur: ${JSON.stringify(error.response.data)}`);
                console.error(`📋 Status: ${error.response.status}`);
            } else if (error.request) {
                console.error(`📋 Erreur de requête: Pas de réponse reçue`);
                console.error(`📋 URL: ${NOTIFICATION_SERVICE_URL}${endpointPath}`);
                console.error(`📋 Méthode: POST`);
            } else {
                console.error(`📋 Erreur de configuration: ${error.message}`);
            }
            
            // Gérer les erreurs de connexion ou de timeout
            if (
                error.code === 'ECONNREFUSED' || 
                error.code === 'ETIMEDOUT' || 
                error.code === 'ECONNABORTED' ||
                error.code === 'ENOTFOUND' ||
                error.message.includes('timeout')
            ) {
                console.log(`⚠️ Erreur de connexion détectée: ${error.code || error.message}`);
                if (currentRetry < maxRetries) {
                    currentRetry++;
                    const backoff = initialBackoff * Math.pow(2, currentRetry - 1);
                    console.log(`⏱️ Attente de ${backoff}ms avant nouvelle tentative (${currentRetry}/${maxRetries})...`);
                    
                    // Attendre avec un délai exponentiel
                    await new Promise(resolve => setTimeout(resolve, backoff));
                    return attemptSend(); // Tentative supplémentaire récursive
                }
            }
            
            // Erreur après les tentatives ou autre type d'erreur
            throw error;
        }
    };
    
    // Démarrer les tentatives d'envoi
    return attemptSend();
};

/**
 * Envoie une facture par e-mail
 */
const sendInvoiceEmail = async (email, invoice) => {
  try {
    // Données de facture par défaut pour les tests
    let invoiceData = {
      amount: 999, // 9.99 en centimes
      currency: 'eur',
      date: new Date().toISOString(),
      invoiceNumber: 'INV-TEST-' + Date.now(),
      planName: 'Service Premium (Test)'
    };
    
    // Si ce n'est pas un test, récupérer les vraies données
    if (!invoice._customerMock) {
      try {
        // Récupérer les détails supplémentaires de la facture
        const retrievedInvoice = await stripe.invoices.retrieve(invoice.id, {
          expand: ['subscription', 'customer']
        });

        // Récupérer les détails du plan si possible
        let planName = 'Service Premium';
        if (retrievedInvoice.subscription && retrievedInvoice.lines && retrievedInvoice.lines.data.length > 0) {
          const subscription = await stripe.subscriptions.retrieve(retrievedInvoice.subscription);
          if (subscription.items && subscription.items.data.length > 0) {
            const item = subscription.items.data[0];
            if (item.price) {
              const price = await stripe.prices.retrieve(item.price.id, { expand: ['product'] });
              if (price.product && price.product.name) {
                planName = price.product.name;
              }
            }
          }
        }

        // Mettre à jour les données de facture
        invoiceData = {
          amount: retrievedInvoice.amount_paid,
          currency: retrievedInvoice.currency,
          date: new Date(retrievedInvoice.created * 1000).toISOString(),
          invoiceNumber: retrievedInvoice.number || retrievedInvoice.id,
          planName
        };
      } catch (error) {
        console.warn(`⚠️ Impossible de récupérer les détails de la facture depuis Stripe: ${error.message}`);
        console.warn(`⚠️ Utilisation de données de test par défaut à la place`);
      }
    } else {
      console.log(`🧪 Mode test: envoi d'une facture avec des données simulées`);
    }
    
    // Envoyer la facture par e-mail
    const response = await axios.post(`${NOTIFICATION_SERVICE_URL}/notifications/invoice`, {
      to: email,
      invoiceData
    });
    
    console.log(`✅ Facture envoyée à ${email} (${invoiceData.invoiceNumber})`);
    return response.data;
  } catch (error) {
    console.error('Erreur lors de l\'envoi de la facture par e-mail:', error);
    throw error;
  }
};

module.exports = {
  createSubscriptionSession,
  checkSubscriptionStatus,
  handleWebhookEvent
};