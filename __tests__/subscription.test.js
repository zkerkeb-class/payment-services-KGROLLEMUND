const request = require('supertest');
const express = require('express');
const createStripeRoutes = require('../routes/index');

// Simuler le module stripeService et ses fonctions exportées
jest.mock('../controllers/stripeService', () => ({
  cancelSubscription: jest.fn(),
  handleWebhookEvent: jest.fn(),
  createSubscriptionSession: jest.fn(),
  checkSubscriptionStatus: jest.fn(),
}));
const stripeService = require('../controllers/stripeService');

// Créer une instance Stripe simulée
const mockStripe = {
  // Cette simulation est nécessaire car le service injecté l'attend
  subscriptions: {
    update: jest.fn(),
  },
  webhooks: {
    constructEvent: jest.fn(),
  },
};

// Initialiser l'application
const app = express();
// Ajouter les middlewares nécessaires que le routeur utilise
app.use(express.json());
// Middleware pour simuler req.rawBody pour le webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/api/payments/webhook') {
    req.rawBody = JSON.stringify(req.body);
  }
  next();
});

const paymentRoutes = createStripeRoutes(mockStripe, stripeService);
app.use('/api/payments', paymentRoutes);


describe('Payment Service Routes', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/payments/cancel-subscription', () => {
    it('should call stripeService.cancelSubscription and return success', async () => {
      const mockResponse = { message: 'Subscription cancellation scheduled successfully' };
      stripeService.cancelSubscription.mockResolvedValue(mockResponse);

      const response = await request(app)
        .post('/api/payments/cancel-subscription')
        .send({ subscriptionId: 'sub_test123' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResponse);
      expect(stripeService.cancelSubscription).toHaveBeenCalledWith('sub_test123');
    });
  });

  describe('POST /api/payments/webhook', () => {
    
    it('should process a valid webhook event', async () => {
      const mockEvent = { type: 'customer.subscription.updated' };
      mockStripe.webhooks.constructEvent.mockReturnValue(mockEvent);
      stripeService.handleWebhookEvent.mockResolvedValue();

      const response = await request(app)
        .post('/api/payments/webhook')
        .send(mockEvent)
        .set('stripe-signature', 't=1,v1=sig');

      expect(response.status).toBe(200);
      expect(stripeService.handleWebhookEvent).toHaveBeenCalledWith(mockEvent);
    });

    it('should return 400 if signature is invalid', async () => {
      const error = new Error('Signature verification failed');
      mockStripe.webhooks.constructEvent.mockImplementation(() => { throw error; });

      const response = await request(app)
        .post('/api/payments/webhook')
        .send({ type: 'any.event' })
        .set('stripe-signature', 't=1,v1=invalid_sig');

      expect(response.status).toBe(400);
      expect(response.text).toContain('Webhook Error: Signature verification failed');
    });
  });
}); 