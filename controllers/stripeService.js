module.exports = function(stripe) {
  const axios = require('axios');

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
   * Annule un abonnement à la fin de la période de facturation
   */
  const cancelSubscription = async (subscriptionId) => {
    try {
      const subscription = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
      });

      return {
        message: 'Subscription cancellation scheduled successfully',
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      };
    } catch (error) {
      console.error('Erreur lors de l\'annulation de l\'abonnement sur Stripe:', error);
      throw new Error('Could not cancel subscription on Stripe.');
    }
  };

  /**
   * Gère les webhooks Stripe
   */
  const handleWebhookEvent = async (event) => {
    try {
      console.log(`🔄 handleWebhookEvent - Début du traitement de l'événement ${event.type}`);
      
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
      console.log(`[LOG] 1. Début du traitement de checkout.session.completed pour la session ${session.id}`);

      // 1. Récupérer les détails du client et de l'abonnement depuis Stripe
      const customer = await stripe.customers.retrieve(session.customer);
      const userEmail = customer.email;
      if (!userEmail) {
        throw new Error(`Le client Stripe ${session.customer} n'a pas d'email associé.`);
      }
      console.log(`[LOG] 2. Client Stripe récupéré: ${userEmail}`);

      const subscription = await stripe.subscriptions.retrieve(session.subscription, {
        expand: ['items.data.price.product']
      });
      console.log(`[LOG] 3. Abonnement Stripe récupéré: ${subscription.id}`);

      // 2. Récupérer l'ID de l'utilisateur depuis notre BDD
      const userResponse = await axios.get(`${DB_SERVICE_URL}/api/users/email/${userEmail}`);
      const userId = userResponse.data.id;
      if (!userId) {
        throw new Error(`Utilisateur non trouvé dans la BDD avec l'email ${userEmail}`);
      }
      console.log(`[LOG] 4. Utilisateur BDD trouvé: ${userId}`);

      // 3. Créer ou mettre à jour l'abonnement dans notre BDD
      const subscriptionData = {
        userId: userId,
        planType: subscription.items.data[0]?.price?.product?.name || 'Service Premium',
        startDate: new Date(subscription.current_period_start * 1000),
        endDate: new Date(subscription.current_period_end * 1000),
        status: subscription.status,
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: subscription.customer,
        isActive: subscription.status === 'active',
        autoRenew: !subscription.cancel_at_period_end,
        lastPaymentDate: new Date(),
        nextPaymentDate: new Date(subscription.current_period_end * 1000),
        amount: (subscription.items.data[0]?.price?.unit_amount) / 100,
        currency: subscription.currency || 'eur'
      };

      console.log('[LOG] 5. Préparation de la requête de création d\'abonnement BDD...');
      const subscriptionResponse = await axios.post(`${DB_SERVICE_URL}/api/subscriptions`, subscriptionData);
      const internalSubscriptionId = subscriptionResponse.data.id;
      console.log(`[LOG] 6. SUCCÈS - Abonnement BDD créé avec l'ID: ${internalSubscriptionId}`);
      
      // 4. Mettre à jour le statut de l'utilisateur dans notre BDD
      console.log('[LOG] 7. Préparation de la requête de mise à jour de l\'utilisateur BDD...');
      await axios.put(`${DB_SERVICE_URL}/api/users/subscription/${userEmail}`, {
        isSubscribed: true,
        subscriptionId: subscription.id,
        numSubscriptionId: internalSubscriptionId, 
        subscriptionEndDate: new Date(subscription.current_period_end * 1000).toISOString()
      });
      console.log(`[LOG] 8. SUCCÈS - Statut de l'utilisateur mis à jour.`);

      // 5. Envoyer une notification de succès
      console.log('[LOG] 9. Préparation de l\'appel au service de notification...');
      await sendSubscriptionNotification(userEmail, 'new', {
        subscriptionId: subscription.id,
        planType: subscriptionData.planType,
        endDate: subscriptionData.endDate.toISOString()
      });
      console.log(`[LOG] 10. SUCCÈS - Notification envoyée.`);
      console.log(`[LOG] FIN. Traitement de checkout.session.completed terminé avec succès pour ${userEmail}`);

    } catch (error) {
      console.error(`[ERREUR FATALE] Échec dans handleCheckoutSessionCompleted:`, error.message);
      if (error.response) {
        console.error('[ERREUR FATALE] Réponse d\'erreur Axios:', JSON.stringify(error.response.data, null, 2));
      }
      // Propager l'erreur pour que le webhook puisse répondre avec un code 500
      // et que Stripe puisse retenter l'envoi.
      throw error;
    }
  };

  /**
   * Gère le paiement réussi d'une facture (renouvellement)
   */
  const handleInvoicePaid = async (invoice) => {
    try {
      console.log('🔄 Traitement du paiement d\'une facture...');
      
      const customer = await stripe.customers.retrieve(invoice.customer);
      const userEmail = customer.email;
      const subscriptionId = invoice.subscription;
      
      // Récupérer les détails de l'abonnement
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      
      // Mettre à jour la date de fin dans la BDD
      const endDate = new Date(subscription.current_period_end * 1000);
      console.log(`📅 Mise à jour de la date de fin pour ${userEmail} à ${endDate.toISOString()}`);
      
      await updateUserSubscriptionEnd(userEmail, endDate);
      
      // Envoyer une notification
      console.log(`🔔 Envoi de notification de renouvellement`);
      await sendSubscriptionNotification(userEmail, 'renewed', {
        endDate: endDate.toISOString(),
        amount: invoice.amount_paid / 100,
        currency: invoice.currency
      });
      
      console.log(`✅ Facture payée traitée pour ${userEmail}`);
      
    } catch (error) {
      console.error('❌ Erreur lors du traitement de handleInvoicePaid:', error);
    }
  };

  /**
   * Gère l'échec d'un paiement de facture
   */
  const handlePaymentFailed = async (invoice) => {
    try {
      // Envoyer une notification à l'utilisateur
      await sendSubscriptionNotification(invoice.customer_email, 'payment_failed');
    } catch (error) {
      console.error('❌ Erreur lors du traitement de handlePaymentFailed:', error);
    }
  };

  /**
   * Gère la mise à jour d'un abonnement
   */
  const handleSubscriptionUpdated = async (subscription) => {
    try {
      console.log(`[LOG] 1. Début du traitement de customer.subscription.updated pour ${subscription.id}`);

      const customer = await stripe.customers.retrieve(subscription.customer);
      const userEmail = customer.email;
      if (!userEmail) {
        throw new Error(`Le client Stripe ${subscription.customer} n'a pas d'email.`);
      }
      console.log(`[LOG] 2. Client récupéré: ${userEmail}`);

      const isCancelled = subscription.cancel_at_period_end;
      console.log(`[LOG] 3. Statut d'annulation (cancel_at_period_end): ${isCancelled}`);

      // Mettre à jour l'abonnement dans la table Subscription de la BDD
      const endDate = isCancelled ? new Date(subscription.cancel_at * 1000) : new Date(subscription.current_period_end * 1000);

      const subscriptionUpdateData = {
        status: isCancelled ? 'cancelled' : subscription.status,
        autoRenew: !isCancelled,
        isActive: !isCancelled,
        endDate: endDate
      };
      
      console.log('[LOG] 4. Préparation de la mise à jour de la table "Subscription"...', subscriptionUpdateData);
      await axios.put(`${DB_SERVICE_URL}/api/subscriptions/stripe/${subscription.id}`, subscriptionUpdateData);
      console.log(`[LOG] 5. SUCCÈS - Table "Subscription" mise à jour.`);

      // Mettre à jour la table User si l'abonnement est annulé
      if (isCancelled) {
        console.log('[LOG] 6. Abonnement annulé. Préparation de la mise à jour de la table "User"...');
        await axios.put(`${DB_SERVICE_URL}/api/users/subscription/${userEmail}`, {
          isSubscribed: false, // Ou une logique pour gérer l'accès jusqu'à la fin de la période
          subscriptionEndDate: new Date(subscription.cancel_at * 1000).toISOString()
        });
        console.log('[LOG] 7. SUCCÈS - Table "User" mise à jour.');

        console.log('[LOG] 8. Préparation de l\'envoi de la notification d\'annulation...');
        await sendSubscriptionNotification(userEmail, 'cancelled', {
          endDate: new Date(subscription.cancel_at * 1000).toISOString()
        });
        console.log('[LOG] 9. SUCCÈS - Notification d\'annulation envoyée.');
      }
      
      console.log(`[LOG] FIN. Traitement de customer.subscription.updated terminé avec succès pour ${userEmail}`);

    } catch (error) {
      console.error(`[ERREUR FATALE] Échec dans handleSubscriptionUpdated:`, error.message);
      if (error.response) {
        console.error('[ERREUR FATALE] Réponse d\'erreur Axios:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  };

  /**
   * Gère la suppression d'un abonnement
   */
  const handleSubscriptionDeleted = async (subscription) => {
    try {
      console.log(`🔄 Traitement de la suppression de l'abonnement ${subscription.id}`);
      const customer = await stripe.customers.retrieve(subscription.customer);
      const userEmail = customer.email;
      
      // Mettre à jour l'abonnement dans la BDD (statut 'canceled')
      await axios.put(`${DB_SERVICE_URL}/api/subscriptions/${subscription.id}`, { status: 'canceled', isActive: false });
      console.log(`✅ Abonnement ${subscription.id} marqué comme supprimé dans la BDD.`);

      // Mettre à jour le statut de l'utilisateur
      await updateUserSubscriptionStatus(userEmail, false);
      
      // Envoyer une notification de suppression
      await sendSubscriptionNotification(userEmail, 'deleted');

    } catch (error) {
      console.error(`❌ Erreur lors du traitement de handleSubscriptionDeleted:`, error.message);
    }
  };

  /**
   * Met à jour le statut d'abonnement d'un utilisateur
   */
  const updateUserSubscriptionStatus = async (userEmail, isSubscribed, subscriptionId = null) => {
    try {
      const url = `${DB_SERVICE_URL}/api/users/subscription/${userEmail}`;
      console.log(`🔄 Mise à jour du statut d'abonnement pour ${userEmail} à ${isSubscribed}`);
      await axios.put(url, { isSubscribed, subscriptionId });
      console.log(`✅ Statut d'abonnement mis à jour pour ${userEmail}`);
    } catch (error) {
      console.error(`❌ Erreur lors de la mise à jour du statut d'abonnement pour ${userEmail}:`, error);
    }
  };

  /**
   * Met à jour la date de fin d'un abonnement pour un utilisateur
   */
  const updateUserSubscriptionEnd = async (email, subscriptionEndDate) => {
    try {
      const url = `${DB_SERVICE_URL}/api/users/subscription-end-date/${email}`;
      console.log(`🔄 Mise à jour de la date de fin d'abonnement pour ${email}`);
      await axios.put(url, { subscriptionEndDate: subscriptionEndDate.toISOString() });
      console.log(`✅ Date de fin d'abonnement mise à jour pour ${email}`);
    } catch (error) {
      console.error(`❌ Erreur lors de la mise à jour de la date de fin pour ${email}:`, error);
    }
  };


  const sendSubscriptionNotification = async (email, type, data = {}) => {
    const urlMap = {
      new: 'subscription/start',
      renewed: 'subscription/renewed',
      cancelled: 'subscription/cancelled',
      deleted: 'subscription/deleted',
      payment_failed: 'subscription/payment-failed'
    };

    if (!urlMap[type]) {
      console.warn(`Type de notification inconnu: ${type}`);
      return;
    }
    
    const endpoint = `${NOTIFICATION_SERVICE_URL}/notifications/${urlMap[type]}`;
    const payload = { email, ...data };
    
    let retries = 3;
    
    const attemptSend = async () => {
      try {
        console.log(`📨 Envoi de la notification '${type}' à ${email}`);
        const response = await axios.post(endpoint, payload);
        console.log(`✅ Notification '${type}' envoyée avec succès à ${email}.`);
        return response;
      } catch (error) {
        console.error(`❌ Échec de l'envoi de la notification '${type}' à ${email}.`);
        if (error.response) {
          console.error('Réponse du service de notification:', error.response.status, error.response.data);
        }
        
        retries--;
        if (retries > 0) {
          console.log(`Retentative dans 5 secondes... (${retries} restantes)`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          return attemptSend();
        } else {
          console.error(`Échec final de l'envoi de la notification après plusieurs tentatives.`);
          throw error; // Propage l'erreur après l'échec final
        }
      }
    };
    
    return attemptSend();
  };


  const sendInvoiceEmail = async (email, invoice) => {
    const url = `${NOTIFICATION_SERVICE_URL}/notifications/invoice`;
    try {
      console.log(`✉️  Envoi de la facture à ${email}`);
      await axios.post(url, { email, invoice });
      console.log('✅ Facture envoyée avec succès.');
    } catch (error) {
      console.error('❌ Échec de l\'envoi de la facture par e-mail:', error.message);
    }
  };


  return {
    createSubscriptionSession,
    checkSubscriptionStatus,
    handleWebhookEvent,
    cancelSubscription,
  };
};