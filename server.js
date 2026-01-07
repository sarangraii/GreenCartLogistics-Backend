// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/greencart', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Models
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'manager' }
});

const DriverSchema = new mongoose.Schema({
  name: { type: String, required: true },
  currentShiftHours: { type: Number, default: 0 },
  past7DayWorkHours: { type: Number, default: 0 },
  isFatigued: { type: Boolean, default: false }
});

const RouteSchema = new mongoose.Schema({
  routeId: { type: String, required: true, unique: true },
  distance: { type: Number, required: true },
  trafficLevel: { type: String, enum: ['Low', 'Medium', 'High'], required: true },
  baseTime: { type: Number, required: true } // in minutes
});

const OrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  valueRs: { type: Number, required: true },
  assignedRoute: { type: String, required: true },
  deliveryTimestamp: { type: Date, required: true },
  assignedDriver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
  actualDeliveryTime: { type: Number }, // in minutes
  isOnTime: { type: Boolean, default: true },
  penalty: { type: Number, default: 0 },
  bonus: { type: Number, default: 0 }
});

const SimulationResultSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  inputs: {
    availableDrivers: Number,
    startTime: String,
    maxHoursPerDay: Number
  },
  results: {
    totalProfit: Number,
    efficiencyScore: Number,
    onTimeDeliveries: Number,
    totalDeliveries: Number,
    fuelCost: Number,
    penalties: Number,
    bonuses: Number
  },
  deliveryBreakdown: [{
    onTime: Number,
    late: Number
  }],
  fuelCostBreakdown: [{
    routeType: String,
    cost: Number
  }]
});

const User = mongoose.model('User', UserSchema);
const Driver = mongoose.model('Driver', DriverSchema);
const Route = mongoose.model('Route', RouteSchema);
const Order = mongoose.model('Order', OrderSchema);
const SimulationResult = mongoose.model('SimulationResult', SimulationResultSchema);

// Auth Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Validation Middleware
const validateSimulationInputs = (req, res, next) => {
  const { availableDrivers, startTime, maxHoursPerDay } = req.body;

  if (!availableDrivers || !startTime || !maxHoursPerDay) {
    return res.status(400).json({ 
      error: 'Missing required parameters: availableDrivers, startTime, maxHoursPerDay' 
    });
  }

  if (availableDrivers < 1 || availableDrivers > 50) {
    return res.status(400).json({ 
      error: 'Available drivers must be between 1 and 50' 
    });
  }

  if (maxHoursPerDay < 1 || maxHoursPerDay > 24) {
    return res.status(400).json({ 
      error: 'Max hours per day must be between 1 and 24' 
    });
  }

  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(startTime)) {
    return res.status(400).json({ 
      error: 'Start time must be in HH:MM format' 
    });
  }

  next();
};

// Auth Routes
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email }, 
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '24h' }
    );

    res.json({ token, user: { email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: 'Server error during login' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = new User({ email, password: hashedPassword });
    await user.save();

    const token = jwt.sign(
      { userId: user._id, email: user.email }, 
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '24h' }
    );

    res.status(201).json({ token, user: { email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// Driver CRUD Routes
app.get('/api/drivers', authenticateToken, async (req, res) => {
  try {
    const drivers = await Driver.find();
    res.json(drivers);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch drivers' });
  }
});

app.post('/api/drivers', authenticateToken, async (req, res) => {
  try {
    const { name, currentShiftHours, past7DayWorkHours } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Driver name is required' });
    }

    const driver = new Driver({
      name,
      currentShiftHours: currentShiftHours || 0,
      past7DayWorkHours: past7DayWorkHours || 0
    });

    await driver.save();
    res.status(201).json(driver);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create driver' });
  }
});

app.put('/api/drivers/:id', authenticateToken, async (req, res) => {
  try {
    const { name, currentShiftHours, past7DayWorkHours } = req.body;
    
    const driver = await Driver.findByIdAndUpdate(
      req.params.id,
      { name, currentShiftHours, past7DayWorkHours },
      { new: true }
    );

    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    res.json(driver);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update driver' });
  }
});

app.delete('/api/drivers/:id', authenticateToken, async (req, res) => {
  try {
    const driver = await Driver.findByIdAndDelete(req.params.id);
    
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    res.json({ message: 'Driver deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete driver' });
  }
});

// Route CRUD Routes
app.get('/api/routes', authenticateToken, async (req, res) => {
  try {
    const routes = await Route.find();
    res.json(routes);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch routes' });
  }
});

app.post('/api/routes', authenticateToken, async (req, res) => {
  try {
    const { routeId, distance, trafficLevel, baseTime } = req.body;

    if (!routeId || !distance || !trafficLevel || !baseTime) {
      return res.status(400).json({ 
        error: 'All fields required: routeId, distance, trafficLevel, baseTime' 
      });
    }

    const route = new Route({ routeId, distance, trafficLevel, baseTime });
    await route.save();
    res.status(201).json(route);
  } catch (error) {
    if (error.code === 11000) {
      res.status(400).json({ error: 'Route ID already exists' });
    } else {
      res.status(500).json({ error: 'Failed to create route' });
    }
  }
});

app.put('/api/routes/:id', authenticateToken, async (req, res) => {
  try {
    const { routeId, distance, trafficLevel, baseTime } = req.body;
    
    const route = await Route.findByIdAndUpdate(
      req.params.id,
      { routeId, distance, trafficLevel, baseTime },
      { new: true }
    );

    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }

    res.json(route);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update route' });
  }
});

app.delete('/api/routes/:id', authenticateToken, async (req, res) => {
  try {
    const route = await Route.findByIdAndDelete(req.params.id);
    
    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }

    res.json({ message: 'Route deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete route' });
  }
});

// Order CRUD Routes
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    const orders = await Order.find().populate('assignedDriver');
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.post('/api/orders', authenticateToken, async (req, res) => {
  try {
    const { orderId, valueRs, assignedRoute, deliveryTimestamp } = req.body;

    if (!orderId || !valueRs || !assignedRoute || !deliveryTimestamp) {
      return res.status(400).json({ 
        error: 'All fields required: orderId, valueRs, assignedRoute, deliveryTimestamp' 
      });
    }

    const order = new Order({ orderId, valueRs, assignedRoute, deliveryTimestamp });
    await order.save();
    res.status(201).json(order);
  } catch (error) {
    if (error.code === 11000) {
      res.status(400).json({ error: 'Order ID already exists' });
    } else {
      res.status(500).json({ error: 'Failed to create order' });
    }
  }
});

app.put('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const { orderId, valueRs, assignedRoute, deliveryTimestamp } = req.body;
    
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { orderId, valueRs, assignedRoute, deliveryTimestamp },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(order);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update order' });
  }
});

app.delete('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ message: 'Order deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

// Simulation Logic
const calculateDeliveryTime = (route, driver, baseTime) => {
  let deliveryTime = baseTime;
  
  // Apply fatigue penalty if driver worked > 8 hours
  if (driver.isFatigued) {
    deliveryTime *= 1.3; // 30% slower
  }
  
  return Math.round(deliveryTime);
};

const calculateFuelCost = (route) => {
  let baseCost = 5 * route.distance; // ₹5/km
  
  if (route.trafficLevel === 'High') {
    baseCost += 2 * route.distance; // +₹2/km surcharge
  }
  
  return baseCost;
};

// Simulation Route
app.post('/api/simulation', authenticateToken, validateSimulationInputs, async (req, res) => {
  try {
    const { availableDrivers, startTime, maxHoursPerDay } = req.body;

    // Fetch drivers, routes, and orders
    const drivers = await Driver.find().limit(availableDrivers);
    const routes = await Route.find();
    const orders = await Order.find();

    if (drivers.length < availableDrivers) {
      return res.status(400).json({ 
        error: `Not enough drivers available. Found ${drivers.length}, requested ${availableDrivers}` 
      });
    }

    // Check for driver fatigue (worked > 8 hours)
    drivers.forEach(driver => {
      driver.isFatigued = driver.currentShiftHours > 8;
    });

    // Create route lookup
    const routeMap = {};
    routes.forEach(route => {
      routeMap[route.routeId] = route;
    });

    let totalProfit = 0;
    let totalFuelCost = 0;
    let totalPenalties = 0;
    let totalBonuses = 0;
    let onTimeDeliveries = 0;
    const fuelCostByTraffic = { Low: 0, Medium: 0, High: 0 };

    // Process each order
    const processedOrders = orders.map((order, index) => {
      const route = routeMap[order.assignedRoute];
      if (!route) return order;

      const driverIndex = index % availableDrivers;
      const assignedDriver = drivers[driverIndex];
      
      // Calculate delivery time
      const actualDeliveryTime = calculateDeliveryTime(assignedDriver, route, route.baseTime);
      
      // Check if delivery is late
      const isLate = actualDeliveryTime > (route.baseTime + 10);
      let penalty = 0;
      let bonus = 0;

      if (isLate) {
        penalty = 50; // ₹50 penalty for late delivery
      } else {
        onTimeDeliveries++;
        // High-value bonus for on-time deliveries
        if (order.valueRs > 1000) {
          bonus = order.valueRs * 0.1; // 10% bonus
        }
      }

      // Calculate fuel cost
      const fuelCost = calculateFuelCost(route);
      totalFuelCost += fuelCost;
      fuelCostByTraffic[route.trafficLevel] += fuelCost;

      totalPenalties += penalty;
      totalBonuses += bonus;
      
      // Calculate order profit
      const orderProfit = order.valueRs + bonus - penalty - fuelCost;
      totalProfit += orderProfit;

      return {
        ...order.toObject(),
        assignedDriver: assignedDriver._id,
        actualDeliveryTime,
        isOnTime: !isLate,
        penalty,
        bonus,
        fuelCost
      };
    });

    // Calculate efficiency score
    const efficiencyScore = orders.length > 0 ? (onTimeDeliveries / orders.length) * 100 : 0;

    // Prepare results
    const results = {
      totalProfit: Math.round(totalProfit),
      efficiencyScore: Math.round(efficiencyScore * 100) / 100,
      onTimeDeliveries,
      totalDeliveries: orders.length,
      fuelCost: Math.round(totalFuelCost),
      penalties: totalPenalties,
      bonuses: Math.round(totalBonuses)
    };

    const deliveryBreakdown = [
      { label: 'On Time', value: onTimeDeliveries },
      { label: 'Late', value: orders.length - onTimeDeliveries }
    ];

    const fuelCostBreakdown = Object.entries(fuelCostByTraffic).map(([traffic, cost]) => ({
      label: `${traffic} Traffic`,
      value: Math.round(cost)
    }));

    // Save simulation result
    const simulationResult = new SimulationResult({
      inputs: { availableDrivers, startTime, maxHoursPerDay },
      results,
      deliveryBreakdown,
      fuelCostBreakdown
    });
    await simulationResult.save();

    res.json({
      results,
      deliveryBreakdown,
      fuelCostBreakdown,
      simulationId: simulationResult._id
    });

  } catch (error) {
    console.error('Simulation error:', error);
    res.status(500).json({ error: 'Simulation failed' });
  }
});

// Get simulation history
app.get('/api/simulations', authenticateToken, async (req, res) => {
  try {
    const simulations = await SimulationResult.find()
      .sort({ timestamp: -1 })
      .limit(10);
    res.json(simulations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch simulation history' });
  }
});

// Dashboard stats
app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const latestSimulation = await SimulationResult.findOne()
      .sort({ timestamp: -1 });

    if (!latestSimulation) {
      return res.json({
        totalProfit: 0,
        efficiencyScore: 0,
        onTimeDeliveries: 0,
        totalDeliveries: 0,
        deliveryBreakdown: [],
        fuelCostBreakdown: []
      });
    }

    res.json({
      ...latestSimulation.results,
      deliveryBreakdown: latestSimulation.deliveryBreakdown,
      fuelCostBreakdown: latestSimulation.fuelCostBreakdown
    });

  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// Initialize sample data
app.post('/api/init-data', async (req, res) => {
  try {
    // Clear existing data
    await Driver.deleteMany({});
    await Route.deleteMany({});
    await Order.deleteMany({});

    // Create sample drivers
    const sampleDrivers = [
      { name: 'Raj Kumar', currentShiftHours: 6, past7DayWorkHours: 45 },
      { name: 'Priya Singh', currentShiftHours: 4, past7DayWorkHours: 32 },
      { name: 'Amit Shah', currentShiftHours: 9, past7DayWorkHours: 52 },
      { name: 'Neha Gupta', currentShiftHours: 7, past7DayWorkHours: 38 },
      { name: 'Vikram Yadav', currentShiftHours: 5, past7DayWorkHours: 28 }
    ];

    // Create sample routes
    const sampleRoutes = [
      { routeId: 'RT001', distance: 15, trafficLevel: 'Low', baseTime: 45 },
      { routeId: 'RT002', distance: 25, trafficLevel: 'High', baseTime: 80 },
      { routeId: 'RT003', distance: 12, trafficLevel: 'Medium', baseTime: 35 },
      { routeId: 'RT004', distance: 30, trafficLevel: 'High', baseTime: 95 },
      { routeId: 'RT005', distance: 8, trafficLevel: 'Low', baseTime: 25 }
    ];

    // Create sample orders
    const sampleOrders = [
      { orderId: 'ORD001', valueRs: 1200, assignedRoute: 'RT001', deliveryTimestamp: new Date() },
      { orderId: 'ORD002', valueRs: 850, assignedRoute: 'RT002', deliveryTimestamp: new Date() },
      { orderId: 'ORD003', valueRs: 1500, assignedRoute: 'RT003', deliveryTimestamp: new Date() },
      { orderId: 'ORD004', valueRs: 750, assignedRoute: 'RT004', deliveryTimestamp: new Date() },
      { orderId: 'ORD005', valueRs: 2000, assignedRoute: 'RT005', deliveryTimestamp: new Date() },
      { orderId: 'ORD006', valueRs: 950, assignedRoute: 'RT001', deliveryTimestamp: new Date() },
      { orderId: 'ORD007', valueRs: 1800, assignedRoute: 'RT002', deliveryTimestamp: new Date() },
      { orderId: 'ORD008', valueRs: 650, assignedRoute: 'RT003', deliveryTimestamp: new Date() }
    ];

    await Driver.insertMany(sampleDrivers);
    await Route.insertMany(sampleRoutes);
    await Order.insertMany(sampleOrders);

    res.json({ message: 'Sample data initialized successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to initialize sample data' });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;