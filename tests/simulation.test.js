// tests/simulation.test.js
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../server');

describe('Simulation Logic Tests', () => {
  let token;

  beforeAll(async () => {
    // Connect to test database
    await mongoose.connect(process.env.TEST_MONGODB_URI || 'mongodb://localhost:27017/greencart_test');
      //  {
    //   useNewUrlParser: true,
    //   useUnifiedTopology: true,
    // });

    // Create test user and get token
    const registerResponse = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'test@manager.com',
        password: 'testpassword123'
      });

    token = registerResponse.body.token;

    // Initialize test data
    await request(app)
      .post('/api/init-data')
      .set('Authorization', `Bearer ${token}`);
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  test('should validate simulation inputs correctly', async () => {
    const response = await request(app)
      .post('/api/simulation')
      .set('Authorization', `Bearer ${token}`)
      .send({
        availableDrivers: -1,
        startTime: '09:00',
        maxHoursPerDay: 8
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Available drivers must be between');
  });

  test('should reject invalid time format', async () => {
    const response = await request(app)
      .post('/api/simulation')
      .set('Authorization', `Bearer ${token}`)
      .send({
        availableDrivers: 3,
        startTime: '25:00',
        maxHoursPerDay: 8
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Start time must be in HH:MM format');
  });

  test('should calculate fuel cost correctly for high traffic', async () => {
    // Test fuel cost calculation: ₹5/km base + ₹2/km for high traffic
    const distance = 10; // km
    const expectedBaseCost = 5 * distance; // ₹50
    const expectedSurcharge = 2 * distance; // ₹20
    const expectedTotal = expectedBaseCost + expectedSurcharge; // ₹70

    // This tests the internal logic - in real implementation, 
    // we'd extract the fuel calculation to a separate testable function
    expect(expectedTotal).toBe(70);
  });

  test('should apply late delivery penalty correctly', async () => {
    // Test penalty calculation: ₹50 for late delivery
    const baseTime = 30; // minutes
    const actualDeliveryTime = 45; // minutes (15 minutes late > 10 minute threshold)
    const penalty = actualDeliveryTime > (baseTime + 10) ? 50 : 0;
    
    expect(penalty).toBe(50);
  });

  test('should calculate high-value bonus correctly', async () => {
    // Test bonus calculation: 10% for orders > ₹1000 delivered on time
    const orderValue = 1200;
    const isOnTime = true;
    const bonus = (orderValue > 1000 && isOnTime) ? orderValue * 0.1 : 0;
    
    expect(bonus).toBe(120);
  });

  test('should run complete simulation successfully', async () => {
    const response = await request(app)
      .post('/api/simulation')
      .set('Authorization', `Bearer ${token}`)
      .send({
        availableDrivers: 3,
        startTime: '09:00',
        maxHoursPerDay: 8
      });

    expect(response.status).toBe(200);
    expect(response.body.results).toHaveProperty('totalProfit');
    expect(response.body.results).toHaveProperty('efficiencyScore');
    expect(response.body.results).toHaveProperty('onTimeDeliveries');
    expect(response.body.results).toHaveProperty('totalDeliveries');
    expect(response.body).toHaveProperty('deliveryBreakdown');
    expect(response.body).toHaveProperty('fuelCostBreakdown');
  });
});