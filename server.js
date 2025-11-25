// server.js

// Load environment variables first (like PORT and DB details)
require('dotenv').config(); 

const express = require('express');
const cors = require('cors'); 

// Import the specific routes handler file. 
// ASSUMPTION: The file is named 'projectRoutes.js' inside the 'routes' folder.
const projectRoutes = require('./routes/projectRoutes');

const app = express();
// Use the port defined in .env (5000), or default to 5000
const PORT = process.env.PORT || 5000; 

// --- Middleware Setup ---

// 1. CORS Configuration: Allows requests from your React frontend (on port 3000)
app.use(cors({
    origin: 'http://localhost:3000' 
}));

// 2. Body Parser: Allows Express to read incoming JSON data from React POST/PUT requests
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));

// --- Route Handling ---

// Root Route: Basic check to ensure the API is running (Fixes the 404 on http://localhost:5000/)
app.get('/', (req, res) => {
    res.json({ message: 'Welcome to the Project Tracker API. Access project data via /api/projects' });
});

// Attach the resource-specific routes. All requests starting with /api/projects 
// will be handed off to the logic defined in projectRoutes.js
app.use('/api/projects', projectRoutes);


// --- Start the Server ---

app.listen(PORT, () => {
    console.log(`Project Tracker API running on http://localhost:${PORT}`);
});