const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

const BDD_SERVICE_URL = process.env.BDD_SERVICE_URL;
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL;

// Créer un abonnement
const createSubscription = async (req, res) => {
    console.log('🚀 DÉBUT - createSubscription - Requête reçue', JSON.stringify(req.body, null, 2));
    try {
        const { userId, planType, paymentMethodId } = req.body;

        // Récupérer l'utilisateur
        const userResponse = await axios.get(`${BDD_SERVICE_URL}/api/users/${userId}`);
        const user = userResponse.data;
        console.log(`✅ Utilisateur récupéré`);

        // Créer ou récupérer le client Stripe
        let customer;
        console.log(`🔍 Recherche du client Stripe`);
        const customers = await stripe.customers.list({ email: user.email });
        if (customers.data.length > 0) {
            customer = customers.data[0];
            console.log(`✅ Client Stripe existant trouvé`);
        } else {
            console.log(`🆕 Création d'un nouveau client Stripe`);
            customer = await stripe.customers.create({
                email: user.email,
                payment_method: paymentMethodId,
                invoice_settings: {
                    default_payment_method: paymentMethodId,
                },
            });
            console.log(`✅ Nouveau client Stripe créé`);
        }

        // Créer l'abonnement Stripe
        const priceId = process.env[`STRIPE_${planType.toUpperCase()}_PRICE_ID`];
        const subscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price: priceId }],
            payment_behavior: 'default_incomplete',
            expand: ['latest_invoice.payment_intent'],
        });
        console.log(`✅ Abonnement Stripe créé`);

        // Calculer la date de fin (30 jours par défaut)
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 30);
        console.log(`📅 Date de fin calculée : ${endDate.toISOString()}`);

        // Créer l'abonnement dans la BDD
        const subscriptionData = {
            userId,
            planType,
            startDate: new Date(),
            endDate,
            stripeSubscriptionId: subscription.id,
            stripeCustomerId: customer.id,
            amount: subscription.items.data[0].price.unit_amount / 100,
            currency: subscription.currency,
            status: subscription.status
        };
        
        
        try {
            const bddResponse = await axios.post(`${BDD_SERVICE_URL}/api/subscriptions`, subscriptionData);
            console.log(`✅ Abonnement enregistré dans la BDD`);
            
            // Envoyer une notification
            console.log(`📧 Envoi d'une notification d'abonnement`);
            await axios.post(`${NOTIFICATION_SERVICE_URL}/notifications/subscription/start`, {
                email: user.email,
                subscriptionData: bddResponse.data
            });
            console.log(`✅ Notification envoyée avec succès`);
            
            res.json({
                subscriptionId: subscription.id,
                clientSecret: subscription.latest_invoice.payment_intent.client_secret,
            });
            console.log(`🏁 FIN - createSubscription - Succès`);
        } catch (bddError) {
            console.error(`❌ ERREUR lors de l'enregistrement dans la BDD:`, bddError);
            console.error(`📦 Détails de l'erreur BDD:`, bddError.response ? bddError.response.data : bddError.message);
            console.error(`🔗 URL complète: ${BDD_SERVICE_URL}/api/subscriptions`);
            console.error(`🧪 Vérification de l'accessibilité de la BDD via healthcheck...`);
            
            try {
                const healthCheck = await axios.get(`${BDD_SERVICE_URL}/api/health`);
                console.log(`🏥 Statut de santé BDD:`, healthCheck.data);
            } catch (healthError) {
                console.error(`💀 Service BDD inaccessible:`, healthError.message);
            }
            
            throw bddError; // Rethrow pour être capturé par le catch extérieur
        }
    } catch (error) {
        console.error('❌ ERREUR GLOBALE lors de la création de l\'abonnement:', error);
        console.error('📦 Stack trace:', error.stack);
        res.status(500).json({ 
            error: 'Erreur lors de la création de l\'abonnement',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

// Annuler un abonnement
const cancelSubscription = async (req, res) => {
    console.log('🚀 DÉBUT - cancelSubscription');
    try {
        const { subscriptionId } = req.params;

        // Récupérer l'abonnement de la BDD
        const subscriptionResponse = await axios.get(`${BDD_SERVICE_URL}/api/subscriptions/${subscriptionId}`);
        const subscription = subscriptionResponse.data;
        console.log(`✅ Abonnement récupéré`);

        // Annuler l'abonnement Stripe
        console.log(`🔍 Annulation de l'abonnement Stripe`);
        await stripe.subscriptions.del(subscription.stripeSubscriptionId);
        console.log(`✅ Abonnement Stripe annulé avec succès`);

        // Mettre à jour l'abonnement dans la BDD
        console.log(`🔍 Mise à jour du statut dans la BDD`);
        const updatedSubscription = await axios.patch(`${BDD_SERVICE_URL}/api/subscriptions/${subscriptionId}`, {
            status: 'cancelled',
            isActive: false
        });
        console.log(`✅ Statut mis à jour dans la BDD`);

        // Envoyer une notification
        console.log(`🔍 Récupération des informations utilisateur`);
        const userResponse = await axios.get(`${BDD_SERVICE_URL}/api/users/${subscription.userId}`);
        console.log(`📧 Envoi d'une notification d'annulation`);
        await axios.post(`${NOTIFICATION_SERVICE_URL}/notifications/subscription/cancelled`, {
            email: userResponse.data.email,
            subscriptionData: updatedSubscription.data
        });
        console.log(`✅ Notification d'annulation envoyée`);

        res.json({ message: 'Abonnement annulé avec succès' });
        console.log(`🏁 FIN - cancelSubscription - Succès`);
    } catch (error) {
        console.error('❌ ERREUR lors de l\'annulation de l\'abonnement:', error);
        console.error('📦 Stack trace:', error.stack);
        res.status(500).json({ 
            error: 'Erreur lors de l\'annulation de l\'abonnement',
            details: error.message 
        });
    }
};

module.exports = {
    createSubscription,
    cancelSubscription
}; 