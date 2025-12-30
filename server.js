// server.js - FIXED VERSION
require('dotenv').config();

const express = require('express');
const cors = require('cors');

// Import routes with error handling
let projectRoutes, panelTasksRoutes, doorTasksRouter, accessoriesTasksRouter, cuttingTasksRouter;
let stripCurtainTasksRouter, systemTasksRouter, adminProjectRoutes, activityLogsRouter;
let subTasksRouter, orderRouter, excelDataRouter;

// Helper function to load modules safely
function loadModule(modulePath, fallbackName) {
    try {
        return require(modulePath);
    } catch (error) {
        console.warn(`⚠️ Could not load ${fallbackName || modulePath}:`, error.message);
        // Return a basic router as fallback
        const router = require('express').Router();
        router.get('/', (req, res) => {
            res.json({ 
                message: `${fallbackName || 'Module'} is not configured`,
                status: 'module_not_found'
            });
        });
        router.get('/health', (req, res) => {
            res.json({ status: 'module_not_available' });
        });
        return router;
    }
}

// Load routes
projectRoutes = loadModule('./routes/projects', 'projectRoutes'); // Remove the "Routes" suffix
panelTasksRoutes = loadModule('./routes/panelTasks', 'panelTasks');
doorTasksRouter = loadModule('./routes/doorTasks', 'doorTasks');
accessoriesTasksRouter = loadModule('./routes/accessoriesTasks', 'accessoriesTasks');
cuttingTasksRouter = loadModule('./routes/cuttingTasks', 'cuttingTasks');
stripCurtainTasksRouter = loadModule('./routes/stripCurtainTasksRouter', 'stripCurtainTasks');
systemTasksRouter = loadModule('./routes/systemTasksRouter', 'systemTasks');
adminProjectRoutes = loadModule('./routes/adminProjectRoutes', 'adminProjects');
activityLogsRouter = loadModule('./routes/activityLogsRouter', 'activityLogs');
subTasksRouter = loadModule('./routes/subtasks', 'subtasks');
orderRouter = loadModule('./routes/orders', 'orders');
excelDataRouter = loadModule('./routes/excelData', 'excelData');

const app = express();

// Get port from environment or use default (Render free tier requires 10000-10020)
const PORT = process.env.PORT || 10000;

// CORS Configuration - simplified
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [])
        : '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']
}));

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// Health check endpoint (required by Render)
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'project-backend',
        environment: process.env.NODE_ENV || 'development',
        port: PORT
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'Project Tracker API',
        version: '1.0.0',
        status: 'running',
        health: '/health',
        api_documentation: {
            projects: '/api/projects',
            panelTasks: '/api/panel-tasks',
            doorTasks: '/api/door-tasks',
            accessoriesTasks: '/api/accessories-tasks',
            cuttingTasks: '/api/cutting-tasks',
            stripCurtainTasks: '/api/strip-curtain-tasks',
            systemTasks: '/api/system-tasks',
            activityLogs: '/api/activity-logs',
            subtasks: '/api/subtasks',
            orders: '/api/orders'
        }
    });
});

// API Routes
app.use('/api/projects', projectRoutes);
app.use('/api/panel-tasks', panelTasksRoutes);
app.use('/api/door-tasks', doorTasksRouter);
app.use('/api/accessories-tasks', accessoriesTasksRouter);
app.use('/api/cutting-tasks', cuttingTasksRouter);
app.use('/api/strip-curtain-tasks', stripCurtainTasksRouter);
app.use('/api/system-tasks', systemTasksRouter);
app.use('/api/admin/projects', adminProjectRoutes);
app.use('/api/activity-logs', activityLogsRouter);
app.use('/api/subtasks', subTasksRouter);
app.use('/api/orders', orderRouter);
app.use('/api', excelDataRouter);

// FIXED: 404 handler - Remove the '*' parameter
app.use((req, res, next) => {
    res.status(404).json({
        error: 'Not Found',
        message: `Cannot ${req.method} ${req.originalUrl}`,
        available_endpoints: [
            '/',
            '/health',
            '/api/projects',
            '/api/panel-tasks',
            '/api/door-tasks',
            '/api/accessories-tasks',
            '/api/cutting-tasks',
            '/api/strip-curtain-tasks',
            '/api/system-tasks',
            '/api/projects/status/approved',
            '/api/activity-logs',
            '/api/subtasks',
            '/api/orders'
        ]
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Server Error:', err.stack || err.message);
    
    const statusCode = err.statusCode || err.status || 500;
    const message = process.env.NODE_ENV === 'production' && statusCode === 500
        ? 'Internal Server Error'
        : err.message || 'Internal Server Error';
    
    res.status(statusCode).json({
        error: message,
        timestamp: new Date().toISOString(),
        path: req.path,
        ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
    });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // In production, we might want to restart, but for Render, let it crash and restart
    process.exit(1);
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
===========================================
🚀 Server running on port: ${PORT}
📁 Environment: ${process.env.NODE_ENV || 'development'}
⏰ Started at: ${new Date().toISOString()}
===========================================
    `);
    console.log('✅ Server is ready to accept requests');
    console.log(`✅ Health check: http://localhost:${PORT}/health`);
    
    // Log loaded modules
    console.log('\n📦 Loaded modules:');
    console.log('- projectRoutes:', projectRoutes ? '✓' : '✗');
    console.log('- panelTasksRoutes:', panelTasksRoutes ? '✓' : '✗');
    console.log('- doorTasksRouter:', doorTasksRouter ? '✓' : '✗');
    console.log('- accessoriesTasksRouter:', accessoriesTasksRouter ? '✓' : '✗');
    console.log('- cuttingTasksRouter:', cuttingTasksRouter ? '✓' : '✗');
    console.log('- stripCurtainTasksRouter:', stripCurtainTasksRouter ? '✓' : '✗');
    console.log('- systemTasksRouter:', systemTasksRouter ? '✓' : '✗');
    console.log('- adminProjectRoutes:', adminProjectRoutes ? '✓' : '✗');
    console.log('- activityLogsRouter:', activityLogsRouter ? '✓' : '✗');
    console.log('- subTasksRouter:', subTasksRouter ? '✓' : '✗');
    console.log('- orderRouter:', orderRouter ? '✓' : '✗');
    console.log('- excelDataRouter:', excelDataRouter ? '✓' : '✗');
});

// Graceful shutdown for Render
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
    
    // Force shutdown after 10 seconds
    setTimeout(() => {
        console.error('Force shutdown after timeout');
        process.exit(1);
    }, 10000);
});

module.exports = server;
