/**
 * Script pour créer les plans d'abonnement Stripe
 * 
 * Ce script crée deux plans d'abonnement:
 * 1. Un plan mensuel à 14.99€/mois
 * 2. Un plan annuel avec 2 mois offerts (10 mois au prix de 14.99€, soit 149.90€/an)
 * 
 * Pour exécuter:
 * node controllers/create-stripe-plans.js
 */

require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fs = require('fs');
const path = require('path');

async function createStripePlans(forceCreate = false) {
  try {
    
    // Vérifier si la clé API Stripe est configurée
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('Clé API Stripe non configurée. Veuillez vérifier votre fichier .env');
    }


    // Vérifier si les plans existent déjà dans .env
    const envPath = path.resolve(__dirname, '..', '.env');
    const envExists = fs.existsSync(envPath);
    let existingEnv = '';
    
    if (envExists) {
      existingEnv = fs.readFileSync(envPath, 'utf8');

      
      if (!forceCreate) {
        const monthlyPlanId = existingEnv.match(/STRIPE_MONTHLY_PLAN_ID=([^\s]+)/);
        const yearlyPlanId = existingEnv.match(/STRIPE_YEARLY_PLAN_ID=([^\s]+)/);
        
        if (monthlyPlanId && yearlyPlanId) {

          
          // Vérifier que les plans existent dans Stripe
          try {
            const monthlyPrice = await stripe.prices.retrieve(monthlyPlanId[1]);
            const yearlyPrice = await stripe.prices.retrieve(yearlyPlanId[1]);
            
            if (monthlyPrice && yearlyPrice) {
              return { monthlyPriceId: monthlyPlanId[1], yearlyPriceId: yearlyPlanId[1] };
            }
          } catch (error) {
            console.log('Les plans configurés n\'existent pas dans Stripe, création de nouveaux plans...');
          }
        }
      } else {
        console.log('Forçage de la création de nouveaux plans...');
      }
    } else {
      console.log('Aucun fichier .env trouvé, création...');
    }

    // Vérifier si le produit existe déjà
    const existingProducts = await stripe.products.list({
      limit: 10,
      active: true
    });
    
    let product;
    if (existingProducts.data.length > 0 && existingProducts.data.some(p => p.name === 'Service Premium')) {
      product = existingProducts.data.find(p => p.name === 'Service Premium');
    } else {
      // Créer un produit pour l'abonnement
      product = await stripe.products.create({
        name: 'Service Premium',
        description: 'Accès complet à toutes les fonctionnalités premium'
      });
    }

    // Créer le prix pour l'abonnement mensuel (14.99€/mois)
    const monthlyPrice = await stripe.prices.create({
      product: product.id,
      unit_amount: 1499, // Montant en centimes (14.99€)
      currency: 'eur',
      recurring: {
        interval: 'month',
        interval_count: 1
      },
      metadata: {
        type: 'MONTHLY'
      }
    });


    // Créer le prix pour l'abonnement annuel (2 mois offerts - 10 * 14.99€ = 149.90€)
    const yearlyPrice = await stripe.prices.create({
      product: product.id,
      unit_amount: 14990, // 10 mois au prix de 14.99€ (en centimes)
      currency: 'eur',
      recurring: {
        interval: 'year',
        interval_count: 1
      },
      metadata: {
        type: 'YEARLY',
        promotion: '2_months_free'
      }
    });


    
    // Préparer le contenu pour le fichier .env
    let envContent = '';
    
    if (envExists) {
      // Préserver toutes les variables existantes
      const envLines = existingEnv.split('\n');
      const updatedLines = [];
      
      let monthlyPlanUpdated = false;
      let yearlyPlanUpdated = false;
      
      // Parcourir chaque ligne et mettre à jour uniquement les plans Stripe
      for (const line of envLines) {
        if (line.trim() === '') {
          updatedLines.push(line);
          continue;
        }
        
        if (line.startsWith('STRIPE_MONTHLY_PLAN_ID=')) {
          updatedLines.push(`STRIPE_MONTHLY_PLAN_ID=${monthlyPrice.id}`);
          monthlyPlanUpdated = true;
        } else if (line.startsWith('STRIPE_YEARLY_PLAN_ID=')) {
          updatedLines.push(`STRIPE_YEARLY_PLAN_ID=${yearlyPrice.id}`);
          yearlyPlanUpdated = true;
        } else {
          updatedLines.push(line);
        }
      }
      
      // Ajouter les plans s'ils n'existaient pas
      if (!monthlyPlanUpdated) {
        updatedLines.push(`STRIPE_MONTHLY_PLAN_ID=${monthlyPrice.id}`);
      }
      
      if (!yearlyPlanUpdated) {
        updatedLines.push(`STRIPE_YEARLY_PLAN_ID=${yearlyPrice.id}`);
      }
      
      envContent = updatedLines.join('\n');
    } else {
      // Créer un nouveau fichier .env
      envContent = `${process.env.STRIPE_SECRET_KEY ? `STRIPE_SECRET_KEY=${process.env.STRIPE_SECRET_KEY}\n` : ''}STRIPE_MONTHLY_PLAN_ID=${monthlyPrice.id}\nSTRIPE_YEARLY_PLAN_ID=${yearlyPrice.id}`;
    }
    
    // Écrire dans le fichier .env
    fs.writeFileSync(envPath, envContent);


    
    // Recharger les variables d'environnement
    process.env.STRIPE_MONTHLY_PLAN_ID = monthlyPrice.id;
    process.env.STRIPE_YEARLY_PLAN_ID = yearlyPrice.id;
    
    return { monthlyPriceId: monthlyPrice.id, yearlyPriceId: yearlyPrice.id };
  } catch (error) {
    console.error('❌ Erreur lors de la création des plans:', error);
    throw error;
  }
}

// Exécuter si appelé directement
if (require.main === module) {
  // Si le script est exécuté avec l'argument --force, forcer la création des plans
  const forceCreate = process.argv.includes('--force');
  createStripePlans(forceCreate);
}

module.exports = createStripePlans; 