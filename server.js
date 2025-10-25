// server.js
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.send('✅ QuickBooks Middleware is running on Render!');
});

// Mock OAuth flow
app.get('/auth/quickbooks', (req, res) => {
  res.send('Redirecting to QuickBooks OAuth (mock)');
});

// Mock callback
app.get('/callback/quickbooks', (req, res) => {
  res.send('OAuth successful! (mock)');
});

// Mock QuickBooks data endpoint
app.get('/api/quickbooks/customers', (req, res) => {
  res.json([
    { id: 1, name: 'Acme Corp', balance: 500 },
    { id: 2, name: 'Beta Ltd', balance: 250 }
  ]);
});

app.post('/api/quickbooks/customers', (req, res) => {
  console.log('Received POST:', req.body);
  res.json({ message: 'Customer created (mock)' });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
